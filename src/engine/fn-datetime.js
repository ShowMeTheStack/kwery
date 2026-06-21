// Built-in date and time functions: now() and the SQL current_* values, extract/date_part, date_trunc, age,
// justify_*, make_*, AT TIME ZONE, date_bin, OVERLAPS, to_char / to_date / to_timestamp, and the arithmetic
// operators between dates, times, timestamps and intervals.
(function (root) {
  'use strict';
  const K = root.K;
  const F = K.F;
  const B = K.T.BASE;
  const Dec = K.Decimal;
  const { DateV, TimeV, TimestampV, IntervalV, Zone, US_DAY, US_HOUR, US_MIN, US_SEC } = K;
  const err = (code, msg, extra) => K.err(code, msg, extra);
  const fdiv = (a, b) => Math.floor(a / b);
  const mod = (a, b) => ((a % b) + b) % b;
  const pad = (n, w) => String(Math.abs(n)).padStart(w, '0');
  const zoneOf = (ctx) => (ctx && ctx.zone) || 'UTC';
  const fin = (x) => Number.isFinite(x);

  // ---- time zones -----------------------------------------------------------------------------------------------
  const ABBREV = {
    utc: '+00:00', gmt: '+00:00', z: '+00:00', ut: '+00:00', zulu: '+00:00', wet: '+00:00', west: '+01:00', bst: '+01:00', cet: '+01:00', cest: '+02:00',
    met: '+01:00', mest: '+02:00', eet: '+02:00', eest: '+03:00', msk: '+03:00', ist: '+05:30', pkt: '+05:00', sgt: '+08:00', hkt: '+08:00', awst: '+08:00',
    jst: '+09:00', kst: '+09:00', acst: '+09:30', aest: '+10:00', aedt: '+11:00', nzst: '+12:00', nzdt: '+13:00', hst: '-10:00', akst: '-09:00', akdt: '-08:00',
    pst: '-08:00', pdt: '-07:00', mst: '-07:00', mdt: '-06:00', cst: '-06:00', cdt: '-05:00', est: '-05:00', edt: '-04:00', ast: '-04:00', adt: '-03:00', nst: '-03:30', ndt: '-02:30',
  };
  /** a zone as the user wrote it to one K.Zone understands; numeric offsets follow POSIX (+05 is five hours west) */
  function zoneName(z) {
    const s = String(z).trim(), l = s.toLowerCase();
    if (ABBREV[l]) return '@' + ABBREV[l];
    const m = /^(?:utc|gmt)?([+-]?)(\d{1,2})(?::?(\d{2}))?(?::?(\d{2}))?$/i.exec(s);
    if (m && /^[+-]?\d|^(utc|gmt)[+-]/i.test(s)) {
      const east = m[1] === '-';
      return '@' + (east ? '+' : '-') + pad(+m[2], 2) + ':' + pad(+m[3] || 0, 2);
    }
    try { Zone.offsetUs(s, 0); } catch (e) { throw err('22023', 'time zone "' + s + '" not recognized'); }
    return s;
  }
  K.zoneName = zoneName;
  const off = (zone, us) => Zone.offsetUs(zone, us);
  /** wall-clock microseconds in a zone to the instant (UTC microseconds) */
  // a time that falls twice (fall back) takes the offset after the transition; one that never happens (spring
  // forward) takes the offset before it, as PostgreSQL does
  const fromLocal = (local, zone) => Zone.fromLocal(zone, local);
  K.fromLocal = fromLocal;
  const localOf = (v, ctx) => (v instanceof DateV ? v.days * US_DAY : v.tz ? v.local(zoneOf(ctx)) : v.us);

  // ---- breaking a timestamp into fields -------------------------------------------------------------------------
  function parts(local) {
    const days = fdiv(local, US_DAY), t = local - days * US_DAY;
    const [y, m, d] = K.civilFromDays(days);
    const dow = mod(days + 4, 7);
    const doy = days - K.daysFromCivil(y, 1, 1) + 1;
    return { y, m, d, h: fdiv(t, US_HOUR), mi: fdiv(t % US_HOUR, US_MIN), s: fdiv(t % US_MIN, US_SEC), us: t % US_SEC, days, dow, doy, tod: t };
  }
  /** ISO 8601 year and week of a day number */
  function isoWeek(days) {
    const dow = mod(days + 3, 7); // 0 = Monday
    const thu = days - dow + 3;
    const [y] = K.civilFromDays(thu);
    const jan1 = K.daysFromCivil(y, 1, 1);
    return { year: y, week: fdiv(thu - jan1, 7) + 1, dow: dow + 1, start: jan1 + mod(3 - mod(jan1 + 3, 7), 7) - 3 };
  }
  const isoYearStart = (y) => { const j4 = K.daysFromCivil(y, 1, 4); return j4 - mod(j4 + 3, 7); };
  const century = (y) => (y > 0 ? fdiv(y + 99, 100) : -fdiv(99 - (y - 1), 100));
  const millennium = (y) => (y > 0 ? fdiv(y + 999, 1000) : -fdiv(999 - (y - 1), 1000));
  const decade = (y) => (y >= 0 ? fdiv(y, 10) : -fdiv(8 - (y - 1), 10));
  K.DT = { parts, isoWeek, fromLocal, zoneName, localOf };

  // ---- the clock ----------------------------------------------------------------------------------------------------
  function usOf(x) {
    if (x === undefined || x === null) return null;
    if (x instanceof TimestampV) return x.us;
    if (x instanceof Date) return x.getTime() * 1000;
    if (typeof x === 'number') return Math.abs(x) > 1e14 ? x : x * 1000;
    if (typeof x === 'bigint') return Number(x);
    return null;
  }
  const txNow = (ctx) => { const u = ctx && (usOf(ctx.txStart) ?? usOf(ctx.stmtStart)); return u ?? K.Clock.nowUs(); };
  const stmtNow = (ctx) => { const u = ctx && (usOf(ctx.stmtStart) ?? usOf(ctx.txStart)); return u ?? K.Clock.nowUs(); };
  const roundPrec = (us, p) => { if (p === undefined || p >= 6) return us; if (p < 0) throw err('22023', 'TIMESTAMP(' + p + ') precision must not be negative'); const q = 10 ** (6 - p); return Math.round(us / q) * q; };
  const prec = (v) => (v.length ? v[0] : undefined);
  F.fn('now', { args: [], ret: 'timestamptz', fn: (v, ctx) => new TimestampV(txNow(ctx), true) });
  F.fn('transaction_timestamp', { args: [], ret: 'timestamptz', fn: (v, ctx) => new TimestampV(txNow(ctx), true) });
  F.fn('statement_timestamp', { args: [], ret: 'timestamptz', fn: (v, ctx) => new TimestampV(stmtNow(ctx), true) });
  F.fn('clock_timestamp', { args: [], ret: 'timestamptz', volatile: true, fn: () => new TimestampV(K.Clock.nowUs(), true) });
  F.fn('timeofday', { args: [], ret: 'text', volatile: true, fn: (v, ctx) => {
    const t = new TimestampV(K.Clock.nowUs(), true), z = zoneOf(ctx), p = parts(t.local(z));
    const o = off(z, t.us) / US_MIN;
    return DAYS[p.dow].slice(0, 3) + ' ' + MONTHS[p.m - 1].slice(0, 3) + ' ' + pad(p.d, 2) + ' ' + pad(p.h, 2) + ':' + pad(p.mi, 2) + ':' + pad(p.s, 2) + '.' + pad(p.us, 6) + ' ' + p.y + ' ' + (o < 0 ? '-' : '+') + pad(fdiv(Math.abs(o), 60), 2) + (Math.abs(o) % 60 ? ':' + pad(Math.abs(o) % 60, 2) : '');
  } });
  F.fn('current_timestamp', { args: ['int4'], minArgs: 0, ret: 'timestamptz', fn: (v, ctx) => new TimestampV(roundPrec(txNow(ctx), prec(v)), true) });
  F.fn('localtimestamp', { args: ['int4'], minArgs: 0, ret: 'timestamp', fn: (v, ctx) => new TimestampV(roundPrec(new TimestampV(txNow(ctx), true).local(zoneOf(ctx)), prec(v)), false) });
  F.fn('current_date', { args: [], ret: 'date', fn: (v, ctx) => new DateV(fdiv(new TimestampV(txNow(ctx), true).local(zoneOf(ctx)), US_DAY)) });
  // current_time is time with time zone in PostgreSQL; there is no timetz here, so it is the local time of day
  const tod = (ctx, p) => new TimeV(mod(roundPrec(new TimestampV(txNow(ctx), true).local(zoneOf(ctx)), p), US_DAY));
  F.fn('current_time', { args: ['int4'], minArgs: 0, ret: 'time', fn: (v, ctx) => tod(ctx, prec(v)) });
  F.fn('localtime', { args: ['int4'], minArgs: 0, ret: 'time', fn: (v, ctx) => tod(ctx, prec(v)) });

  // ---- extract and date_part -------------------------------------------------------------------------------------------
  const UNIT = {};
  for (const [u, names] of Object.entries({
    microseconds: 'microsecond microseconds microsecon us usec usecs useconds', milliseconds: 'millisecond milliseconds millisecon ms msec msecs mseconds',
    second: 'second seconds s sec secs', minute: 'minute minutes m min mins', hour: 'hour hours h hr hrs', day: 'day days d', week: 'week weeks w',
    month: 'month months mon mons', quarter: 'quarter qtr', year: 'year years y yr yrs', decade: 'decade decades dec decs',
    century: 'century centuries c cent', millennium: 'millennium millennia mil mils', epoch: 'epoch', dow: 'dow', isodow: 'isodow', doy: 'doy',
    isoyear: 'isoyear', julian: 'julian j', timezone: 'timezone', timezone_hour: 'timezone_h timezone_hour', timezone_minute: 'timezone_m timezone_minute',
  })) for (const n of names.split(' ')) UNIT[n] = u;
  const unitOf = (text, t) => {
    const u = UNIT[String(text).toLowerCase().trim()];
    if (!u) throw err('22023', 'unit "' + String(text).toLowerCase() + '" not recognized for type ' + t.name);
    return u;
  };
  const unsupported = (u, t) => err('0A000', 'unit "' + u + '" not supported for type ' + t.name);
  const D = (n, s) => new Dec(BigInt(n), s || 0);
  /** the field as an exact decimal (EXTRACT); date_part converts it to float8 */
  function extractTs(u, v, t, ctx) {
    if (!fin(v.us)) {
      if (['epoch', 'julian', 'year', 'decade', 'century', 'millennium', 'isoyear'].includes(u)) return v.us > 0 ? Infinity : -Infinity;
      if (u === 'timezone' || u === 'timezone_hour' || u === 'timezone_minute') { if (!v.tz) throw unsupported(u, t); }
      return null;
    }
    const zone = zoneOf(ctx), l = localOf(v, ctx), p = parts(l);
    switch (u) {
      case 'microseconds': return D(p.s * 1e6 + p.us);
      case 'milliseconds': return D(p.s * 1e6 + p.us, 3);
      case 'second': return D(p.s * 1e6 + p.us, 6);
      case 'minute': return D(p.mi);
      case 'hour': return D(p.h);
      case 'day': return D(p.d);
      case 'month': return D(p.m);
      case 'quarter': return D(fdiv(p.m - 1, 3) + 1);
      case 'year': return D(p.y > 0 ? p.y : p.y - 1);
      case 'decade': return D(decade(p.y));
      case 'century': return D(century(p.y));
      case 'millennium': return D(millennium(p.y));
      case 'week': return D(isoWeek(p.days).week);
      case 'isoyear': { const y = isoWeek(p.days).year; return D(y > 0 ? y : y - 1); }
      case 'dow': return D(p.dow);
      case 'isodow': return D(p.dow === 0 ? 7 : p.dow);
      case 'doy': return D(p.doy);
      case 'epoch': return new Dec(BigInt(v.tz ? v.us : l), 6);
      case 'julian': return D(p.days + 2440588).add(D(p.tod).div(D(US_DAY)));
      case 'timezone': case 'timezone_hour': case 'timezone_minute': {
        if (!v.tz) throw unsupported(u, t);
        const o = off(zone, v.us) / US_SEC;
        return D(u === 'timezone' ? o : u === 'timezone_hour' ? Math.trunc(o / 3600) : Math.trunc((o % 3600) / 60));
      }
    }
    throw unsupported(u, t);
  }
  function extractDate(u, v, t) {
    if (!fin(v.days)) {
      if (['epoch', 'julian', 'year', 'decade', 'century', 'millennium', 'isoyear'].includes(u)) return v.days > 0 ? Infinity : -Infinity;
      if (['day', 'month', 'quarter', 'week', 'dow', 'isodow', 'doy'].includes(u)) return null;
      throw unsupported(u, t);
    }
    switch (u) {
      case 'day': case 'month': case 'quarter': case 'year': case 'decade': case 'century': case 'millennium': case 'week': case 'isoyear': case 'dow': case 'isodow': case 'doy':
        return extractTs(u, new TimestampV(v.days * US_DAY, false), t);
      case 'epoch': return D(v.days * 86400);
      case 'julian': return D(v.days + 2440588);
    }
    throw unsupported(u, t);
  }
  function extractTime(u, v, t) {
    const us = v.us;
    switch (u) {
      case 'microseconds': return D(us % US_MIN);
      case 'milliseconds': return D(us % US_MIN, 3);
      case 'second': return D(us % US_MIN, 6);
      case 'minute': return D(fdiv(us % US_HOUR, US_MIN));
      case 'hour': return D(fdiv(us, US_HOUR));
      case 'epoch': return D(us, 6);
    }
    throw unsupported(u, t);
  }
  function extractIv(u, v, t) {
    const y = Math.trunc(v.months / 12);
    switch (u) {
      case 'microseconds': return D(v.us % US_MIN);
      case 'milliseconds': return D(v.us % US_MIN, 3);
      case 'second': return D(v.us % US_MIN, 6);
      case 'minute': return D(Math.trunc((v.us % US_HOUR) / US_MIN));
      case 'hour': return D(Math.trunc(v.us / US_HOUR));
      case 'day': return D(v.days);
      case 'month': return D(v.months % 12);
      case 'quarter': return D(Math.trunc((v.months % 12) / 3) + 1);
      case 'year': return D(y);
      case 'decade': return D(Math.trunc(y / 10));
      case 'century': return D(Math.trunc(y / 100));
      case 'millennium': return D(Math.trunc(y / 1000));
      case 'epoch': return new Dec(BigInt(v.us) + BigInt(y) * 31557600000000n + BigInt(v.months % 12) * 2592000000000n + BigInt(v.days) * 86400000000n, 6);
    }
    throw unsupported(u, t);
  }
  function extract(field, v, t, ctx) {
    const u = unitOf(field, t);
    if (v instanceof DateV) return extractDate(u, v, t);
    if (v instanceof TimeV) return extractTime(u, v, t);
    if (v instanceof IntervalV) return extractIv(u, v, t);
    return extractTs(u, v, t, ctx);
  }
  const asFloat = (d) => (d === null ? null : typeof d === 'number' ? d : d.toNumber());
  const asNum = (d) => d;
  for (const t of ['timestamptz', 'timestamp', 'date', 'time', 'interval']) {
    F.fn('extract', { args: ['text', t], ret: 'numeric', fn: (v, ctx, info) => asNum(extract(v[0], v[1], info.at[1], ctx)) });
    if (t === 'date') F.fn('date_part', { args: ['text', t], ret: 'float8', fn: (v, ctx) => asFloat(extractTs(unitOf(v[0], B.timestamp), new TimestampV(v[1].days * US_DAY, false), B.timestamp, ctx)) });
    else F.fn('date_part', { args: ['text', t], ret: 'float8', fn: (v, ctx, info) => asFloat(extract(v[0], v[1], info.at[1], ctx)) });
  }

  // ---- date_trunc ------------------------------------------------------------------------------------------------------
  const TRUNC = ['microseconds', 'milliseconds', 'second', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year', 'decade', 'century', 'millennium'];
  function truncLocal(u, l, t) {
    const p = parts(l);
    let y = p.y, m = p.m, d = p.d, time = p.tod;
    switch (u) {
      case 'millennium': y = y > 0 ? fdiv(y + 999, 1000) * 1000 - 999 : -fdiv(999 - (y - 1), 1000) * 1000 + 1; m = 1; d = 1; time = 0; break;
      case 'century': y = y > 0 ? fdiv(y + 99, 100) * 100 - 99 : -fdiv(99 - (y - 1), 100) * 100 + 1; m = 1; d = 1; time = 0; break;
      case 'decade': y = y > 0 ? fdiv(y, 10) * 10 : -fdiv(8 - (y - 1), 10) * 10; m = 1; d = 1; time = 0; break;
      case 'year': m = 1; d = 1; time = 0; break;
      case 'quarter': m = 3 * fdiv(m - 1, 3) + 1; d = 1; time = 0; break;
      case 'month': d = 1; time = 0; break;
      case 'week': { const w = isoWeek(p.days); return (p.days - w.dow + 1) * US_DAY; }
      case 'day': time = 0; break;
      case 'hour': time = p.h * US_HOUR; break;
      case 'minute': time = fdiv(time, US_MIN) * US_MIN; break;
      case 'second': time = fdiv(time, US_SEC) * US_SEC; break;
      case 'milliseconds': time = fdiv(time, 1000) * 1000; break;
      case 'microseconds': break;
      default: throw unsupported(u, t);
    }
    return K.daysFromCivil(y, m, d) * US_DAY + time;
  }
  function dateTrunc(field, v, t, zone) {
    const u = unitOf(field, t);
    if (['epoch', 'dow', 'isodow', 'doy'].includes(u)) throw err('22023', 'unit "' + String(field).toLowerCase() + '" not recognized for type ' + t.name);
    if (!TRUNC.includes(u)) throw unsupported(u, t);
    if (!fin(v.us)) return v;
    if (!v.tz) return new TimestampV(truncLocal(u, v.us, t), false);
    const l = v.local(zone), tl = truncLocal(u, l, t);
    if (TRUNC.indexOf(u) < TRUNC.indexOf('day')) return new TimestampV(v.us - (l - tl), true);
    return new TimestampV(fromLocal(tl, zone), true);
  }
  F.fn('date_trunc', [
    { args: ['text', 'timestamptz'], ret: 'timestamptz', fn: (v, ctx, info) => dateTrunc(v[0], v[1], info.at[1], zoneOf(ctx)) },
    { args: ['text', 'timestamp'], ret: 'timestamp', fn: (v, ctx, info) => dateTrunc(v[0], v[1], info.at[1], zoneOf(ctx)) },
    { args: ['text', 'date'], ret: 'timestamptz', fn: (v, ctx) => dateTrunc(v[0], K.T.cast(v[1], B.date, B.timestamptz, false, ctx), B.timestamptz, zoneOf(ctx)) },
    { args: ['text', 'timestamptz', 'text'], ret: 'timestamptz', fn: (v) => dateTrunc(v[0], v[1], B.timestamptz, zoneName(v[2])) },
    { args: ['text', 'interval'], ret: 'interval', fn: (v, ctx, info) => {
      const u = unitOf(v[0], info.at[1]), iv = v[1];
      const y = Math.trunc(iv.months / 12);
      switch (u) {
        case 'millennium': return new IntervalV(Math.trunc(y / 1000) * 12000, 0, 0);
        case 'century': return new IntervalV(Math.trunc(y / 100) * 1200, 0, 0);
        case 'decade': return new IntervalV(Math.trunc(y / 10) * 120, 0, 0);
        case 'year': return new IntervalV(y * 12, 0, 0);
        case 'quarter': return new IntervalV(y * 12 + Math.trunc((iv.months % 12) / 3) * 3, 0, 0);
        case 'month': return new IntervalV(iv.months, 0, 0);
        case 'day': return new IntervalV(iv.months, iv.days, 0);
        case 'hour': return new IntervalV(iv.months, iv.days, Math.trunc(iv.us / US_HOUR) * US_HOUR);
        case 'minute': return new IntervalV(iv.months, iv.days, Math.trunc(iv.us / US_MIN) * US_MIN);
        case 'second': return new IntervalV(iv.months, iv.days, Math.trunc(iv.us / US_SEC) * US_SEC);
        case 'milliseconds': return new IntervalV(iv.months, iv.days, Math.trunc(iv.us / 1000) * 1000);
        case 'microseconds': return iv;
      }
      if (u === 'week') throw err('0A000', 'unit "week" not supported for type interval', { detail: 'Months usually have fractional weeks.' });
      throw unsupported(u, info.at[1]);
    } },
  ]);

  // ---- age and justify ----------------------------------------------------------------------------------------------------
  function age(l1, l2) {
    if (!fin(l1) || !fin(l2)) { if (l1 === l2) throw err('22008', 'interval out of range'); return IntervalV.inf(fin(l1) ? -Math.sign(l2) : Math.sign(l1)); }
    const a = parts(l1), b = parts(l2);
    let fsec = a.us - b.us, sec = a.s - b.s, min = a.mi - b.mi, hour = a.h - b.h, mday = a.d - b.d, mon = a.m - b.m, year = a.y - b.y;
    const neg = l1 < l2;
    if (neg) { fsec = -fsec; sec = -sec; min = -min; hour = -hour; mday = -mday; mon = -mon; year = -year; }
    while (fsec < 0) { fsec += US_SEC; sec--; }
    while (sec < 0) { sec += 60; min--; }
    while (min < 0) { min += 60; hour--; }
    while (hour < 0) { hour += 24; mday--; }
    while (mday < 0) {
      if (neg) mday += K.monthDays(a.y, a.m); else mday += K.monthDays(b.y, b.m);
      mon--;
    }
    while (mon < 0) { mon += 12; year--; }
    const iv = new IntervalV(year * 12 + mon, mday, ((hour * 60 + min) * 60 + sec) * US_SEC + fsec);
    return neg ? iv.neg() : iv;
  }
  const midnight = (ctx) => fdiv(new TimestampV(txNow(ctx), true).local(zoneOf(ctx)), US_DAY) * US_DAY;
  F.fn('age', [
    { args: ['timestamptz', 'timestamptz'], ret: 'interval', fn: (v, ctx) => age(v[0].local(zoneOf(ctx)), v[1].local(zoneOf(ctx))) },
    { args: ['timestamp', 'timestamp'], ret: 'interval', fn: (v) => age(v[0].us, v[1].us) },
    { args: ['timestamptz'], ret: 'interval', fn: (v, ctx) => age(midnight(ctx), v[0].local(zoneOf(ctx))) },
    { args: ['timestamp'], ret: 'interval', fn: (v, ctx) => age(midnight(ctx), v[0].us) },
  ]);
  function justifyHours(iv) {
    let days = iv.days + Math.trunc(iv.us / US_DAY), us = iv.us % US_DAY;
    if (days > 0 && us < 0) { us += US_DAY; days--; } else if (days < 0 && us > 0) { us -= US_DAY; days++; }
    return new IntervalV(iv.months, days, us);
  }
  function justifyDays(iv) {
    let months = iv.months + Math.trunc(iv.days / 30), days = iv.days % 30;
    if (months > 0 && days < 0) { days += 30; months--; } else if (months < 0 && days > 0) { days -= 30; months++; }
    return new IntervalV(months, days, iv.us);
  }
  function justifyInterval(iv) {
    let { months, days, us } = iv;
    if ((days > 0 && us > 0) || (days < 0 && us < 0)) { const w = Math.trunc(days / 30); days -= w * 30; months += w; }
    days += Math.trunc(us / US_DAY); us %= US_DAY;
    const w = Math.trunc(days / 30); days -= w * 30; months += w;
    if (months > 0 && (days < 0 || (days === 0 && us < 0))) { days += 30; months--; }
    else if (months < 0 && (days > 0 || (days === 0 && us > 0))) { days -= 30; months++; }
    if (days > 0 && us < 0) { us += US_DAY; days--; } else if (days < 0 && us > 0) { us -= US_DAY; days++; }
    return new IntervalV(months, days, us);
  }
  F.fn('justify_hours', { args: ['interval'], ret: 'interval', fn: (v) => justifyHours(v[0]) });
  F.fn('justify_days', { args: ['interval'], ret: 'interval', fn: (v) => justifyDays(v[0]) });
  F.fn('justify_interval', { args: ['interval'], ret: 'interval', fn: (v) => justifyInterval(v[0]) });

  // ---- make_* -------------------------------------------------------------------------------------------------------------
  function makeDays(y, m, d) {
    const yy = y < 0 ? y + 1 : y;
    if (y === 0 || !(m >= 1 && m <= 12) || !(d >= 1 && d <= K.monthDays(yy, m))) throw err('22008', 'date field value out of range: ' + y + '-' + pad(m, 2) + '-' + pad(d, 2));
    return K.daysFromCivil(yy, m, d);
  }
  function makeTime(h, m, s) {
    const fmt = () => h + ':' + pad(m, 2) + ':' + (Number.isInteger(s) && s >= 0 && s < 10 ? '0' + s : String(s));
    if (h < 0 || h > 24 || m < 0 || m > 59 || !(s >= 0 && s <= 60) || (h === 24 && (m > 0 || s > 0))) throw err('22008', 'time field value out of range: ' + fmt());
    return h * US_HOUR + m * US_MIN + Math.round(s * US_SEC);
  }
  F.fn('make_date', { args: ['int4', 'int4', 'int4'], ret: 'date', fn: (v) => new DateV(makeDays(v[0], v[1], v[2])) });
  F.fn('make_time', { args: ['int4', 'int4', 'float8'], ret: 'time', fn: (v) => new TimeV(makeTime(v[0], v[1], v[2])) });
  const makeTs = (v) => makeDays(v[0], v[1], v[2]) * US_DAY + makeTime(v[3], v[4], v[5]);
  F.fn('make_timestamp', { args: ['int4', 'int4', 'int4', 'int4', 'int4', 'float8'], ret: 'timestamp', fn: (v) => new TimestampV(makeTs(v), false) });
  F.fn('make_timestamptz', { args: ['int4', 'int4', 'int4', 'int4', 'int4', 'float8', 'text'], minArgs: 6, ret: 'timestamptz', fn: (v, ctx) => new TimestampV(fromLocal(makeTs(v), v.length > 6 ? makeZone(v[6]) : zoneOf(ctx)), true) });
  // unlike AT TIME ZONE, make_timestamptz reads a numeric offset the ISO way (+05:30 is east of Greenwich)
  const makeZone = (z) => (/^\s*[+-]\d/.test(z) ? zoneName(String(z).trim().replace(/^[+-]/, (c) => (c === '+' ? '-' : '+'))) : zoneName(z));
  F.fn('make_interval', { args: ['int4', 'int4', 'int4', 'int4', 'int4', 'int4', 'float8'], names: ['years', 'months', 'weeks', 'days', 'hours', 'mins', 'secs'], defaults: [0, 0, 0, 0, 0, 0, 0], minArgs: 0, ret: 'interval', fn: (v) => {
    const [y = 0, mo = 0, w = 0, d = 0, h = 0, mi = 0, s = 0] = v;
    if (!Number.isFinite(s)) throw err('22008', 'interval out of range');
    return new IntervalV(y * 12 + mo, w * 7 + d, h * US_HOUR + mi * US_MIN + Math.round(s * US_SEC));
  } });
  F.fn('isfinite', [
    { args: ['date'], ret: 'bool', fn: (v) => fin(v[0].days) },
    { args: ['timestamptz'], ret: 'bool', fn: (v) => fin(v[0].us) },
    { args: ['timestamp'], ret: 'bool', fn: (v) => fin(v[0].us) },
    { args: ['interval'], ret: 'bool', fn: () => true },
  ]);
  F.fn('to_timestamp', { args: ['float8'], ret: 'timestamptz', fn: (v) => {
    const x = v[0];
    if (Number.isNaN(x)) throw err('22008', 'timestamp cannot be NaN');
    if (!fin(x)) return new TimestampV(x, true);
    if (x < -210866803200 || x >= 9224318016000) throw err('22008', 'timestamp out of range: "' + K.T.floatOut(x) + '"');
    return new TimestampV(Math.round(x * 1e6), true);
  } });

  // ---- AT TIME ZONE ------------------------------------------------------------------------------------------------------------
  const ivZone = (iv) => { if (iv.months || iv.days) throw err('22023', 'interval time zone "' + iv.toString() + '" must not include months or days'); const o = iv.us / US_MIN; return '@' + (o < 0 ? '-' : '+') + pad(fdiv(Math.abs(o), 60), 2) + ':' + pad(Math.abs(o) % 60, 2); };
  const atZone = (z) => (z instanceof IntervalV ? ivZone(z) : zoneName(z));
  const toLocalTs = (v, z) => new TimestampV(fin(v.us) ? v.us + off(z, v.us) : v.us, false);
  const toInstant = (v, z) => new TimestampV(fromLocal(v.us, z), true);
  F.fn('timezone', [
    { args: ['text', 'timestamptz'], ret: 'timestamp', fn: (v) => toLocalTs(v[1], atZone(v[0])) },
    { args: ['text', 'timestamp'], ret: 'timestamptz', fn: (v) => toInstant(v[1], atZone(v[0])) },
    { args: ['text', 'date'], ret: 'timestamp', fn: (v, ctx) => toLocalTs(K.T.cast(v[1], B.date, B.timestamptz, false, ctx), atZone(v[0])) },
    { args: ['interval', 'timestamptz'], ret: 'timestamp', fn: (v) => toLocalTs(v[1], atZone(v[0])) },
    { args: ['interval', 'timestamp'], ret: 'timestamptz', fn: (v) => toInstant(v[1], atZone(v[0])) },
  ]);

  // ---- date_bin and OVERLAPS -------------------------------------------------------------------------------------------------
  function dateBin(stride, ts, origin, tz) {
    if (stride.months) throw err('0A000', 'timestamps cannot be binned into intervals containing months or years');
    const s = stride.days * US_DAY + stride.us;
    if (s <= 0) throw err('22008', 'stride must be greater than zero');
    if (!fin(origin.us)) throw err('22008', 'origin out of range');
    if (!fin(ts.us)) return ts;
    const diff = ts.us - origin.us, m = diff % s;
    let r = origin.us + diff - m;
    if (m < 0) r -= s;
    return new TimestampV(r, tz);
  }
  F.fn('date_bin', [
    { args: ['interval', 'timestamptz', 'timestamptz'], ret: 'timestamptz', fn: (v) => dateBin(v[0], v[1], v[2], true) },
    { args: ['interval', 'timestamp', 'timestamp'], ret: 'timestamp', fn: (v) => dateBin(v[0], v[1], v[2], false) },
  ]);
  /** a value of an OVERLAPS row as microseconds (an interval end is relative to the start) */
  function ovPoint(x, t, ctx, start) {
    if (x === null) return null;
    if (x instanceof IntervalV) return start === null ? null : addIv(start, x, 1, null);
    if (x instanceof DateV) return x.days * US_DAY;
    if (x instanceof TimeV) return x.us;
    if (x instanceof TimestampV) return x.us;
    if (typeof x === 'string') {
      if (start !== null && /[a-z]/i.test(x) && !/^\d{4}-/.test(x)) { try { return addIv(start, IntervalV.parse(x), 1, null); } catch (e) { /* not an interval */ } }
      return TimestampV.parse(x, false, zoneOf(ctx)).us;
    }
    return null;
  }
  F.fn('overlaps', { args: ['anyrow', 'anyrow'], strict: false, ret: 'bool', fn: (v, ctx, info) => {
    const pts = (r, t) => {
      if (!(r instanceof K.RowV) || r.values.length !== 2) throw err('42601', 'wrong number of parameters on left side of OVERLAPS expression');
      const ft = t && t.fields ? t.fields.map((f) => f.type) : [];
      const s = ovPoint(r.values[0], ft[0], ctx, null);
      return [s, ovPoint(r.values[1], ft[1], ctx, s)];
    };
    let [s1, e1] = pts(v[0], info.at[0]), [s2, e2] = pts(v[1], info.at[1]);
    if (s1 === null) { if (e1 === null) return null; s1 = e1; e1 = null; } else if (e1 !== null && s1 > e1) [s1, e1] = [e1, s1];
    if (s2 === null) { if (e2 === null) return null; s2 = e2; e2 = null; } else if (e2 !== null && s2 > e2) [s2, e2] = [e2, s2];
    if (s1 > s2) { if (e2 === null) return null; if (s1 < e2) return true; if (e1 === null) return null; return false; }
    if (s1 < s2) { if (e1 === null) return null; if (s2 < e1) return true; if (e2 === null) return null; return false; }
    if (e1 === null || e2 === null) return null;
    return true;
  } });

  // ---- arithmetic -------------------------------------------------------------------------------------------------------------
  /** add an interval to wall-clock microseconds; months clamp the day to the month's end, as PostgreSQL does */
  function addIv(us, iv, sign, zone) {
    const inf = iv.infSign() * sign;
    if (inf) { if (!fin(us) && Math.sign(us) !== inf) throw err('22008', 'timestamp out of range'); return inf * Infinity; }
    if (!fin(us)) return us;
    let local = zone ? us + off(zone, us) : us;
    const tz = !!zone;
    if (iv.months) {
      const days = fdiv(local, US_DAY), rest = local - days * US_DAY;
      let [y, m, d] = K.civilFromDays(days);
      const mm = m - 1 + sign * iv.months;
      y += fdiv(mm, 12); m = mod(mm, 12) + 1;
      d = Math.min(d, K.monthDays(y, m));
      local = K.daysFromCivil(y, m, d) * US_DAY + rest;
    }
    if (iv.days) local += sign * iv.days * US_DAY;
    let r = tz && (iv.months || iv.days) ? fromLocal(local, zone) : tz ? us : local;
    r += sign * iv.us;
    if (r < -211813488000000000 || r >= 9224318016000000000) throw err('22008', 'timestamp out of range');
    return r;
  }
  K.DT.addIv = addIv;
  const dateOut = (d) => { if (fin(d) && (d < -2440588 || d > 2145031948)) throw err('22008', 'date out of range'); return new DateV(d); };
  const tsOf = (d) => new TimestampV(d.days * US_DAY, false);
  const ivMul = (iv, f) => {
    if (Number.isNaN(f)) throw err('22008', 'interval out of range');
    const m = iv.months * f, dd = iv.days * f;
    if (!fin(m) || !fin(dd) || Math.abs(m) > 2147483647 || Math.abs(dd) > 2147483647) throw err('22008', 'interval out of range');
    const rm = Math.trunc(m); let rd = Math.trunc(dd);
    const tsr = (x) => Math.round(x * 1e6) / 1e6;
    const mrd = tsr((iv.months * f - rm) * 30);
    let sr = tsr((iv.days * f - rd + mrd - Math.trunc(mrd)) * 86400);
    if (Math.abs(sr) >= 86400) { rd += Math.trunc(sr / 86400); sr -= Math.trunc(sr / 86400) * 86400; }
    rd += Math.trunc(mrd);
    const us = Math.round(iv.us * f + sr * 1e6);
    if (!fin(us) || Math.abs(us) >= 9223372036854775807) throw err('22008', 'interval out of range');
    return new IntervalV(rm, rd, us);
  };
  const ivDiv = (iv, f) => {
    if (f === 0) throw err('22012', 'division by zero');
    if (Number.isNaN(f)) throw err('22008', 'interval out of range');
    const rm = Math.trunc(iv.months / f); let rd = Math.trunc(iv.days / f);
    const tsr = (x) => Math.round(x * 1e6) / 1e6;
    const mrd = tsr((iv.months / f - rm) * 30);
    let sr = tsr((iv.days / f - rd + mrd - Math.trunc(mrd)) * 86400);
    if (Math.abs(sr) >= 86400) { rd += Math.trunc(sr / 86400); sr -= Math.trunc(sr / 86400) * 86400; }
    rd += Math.trunc(mrd);
    return new IntervalV(rm, rd, Math.round(iv.us / f + sr * 1e6));
  };
  const tsDiff = (a, b) => {
    if (!fin(a.us) || !fin(b.us)) {
      // infinite timestamps give infinite intervals, unless both are infinite the same way
      if (a.us === b.us) throw err('22008', 'interval out of range');
      return IntervalV.inf(fin(a.us) ? -Math.sign(b.us) : Math.sign(a.us));
    }
    return justifyHours(new IntervalV(0, 0, a.us - b.us));
  };
  const op = F.op;
  op('+', [
    { args: ['date', 'int4'], ret: 'date', fn: (v) => dateOut(v[0].days + v[1]) },
    { args: ['int4', 'date'], ret: 'date', fn: (v) => dateOut(v[1].days + v[0]) },
    { args: ['date', 'interval'], ret: 'timestamp', fn: (v) => new TimestampV(addIv(tsOf(v[0]).us, v[1], 1, null), false) },
    { args: ['interval', 'date'], ret: 'timestamp', fn: (v) => new TimestampV(addIv(tsOf(v[1]).us, v[0], 1, null), false) },
    { args: ['date', 'time'], ret: 'timestamp', fn: (v) => new TimestampV(fin(v[0].days) ? v[0].days * US_DAY + v[1].us : v[0].days, false) },
    { args: ['time', 'date'], ret: 'timestamp', fn: (v) => new TimestampV(fin(v[1].days) ? v[1].days * US_DAY + v[0].us : v[1].days, false) },
    { args: ['timestamptz', 'interval'], ret: 'timestamptz', fn: (v, ctx) => new TimestampV(addIv(v[0].us, v[1], 1, zoneOf(ctx)), true) },
    { args: ['interval', 'timestamptz'], ret: 'timestamptz', fn: (v, ctx) => new TimestampV(addIv(v[1].us, v[0], 1, zoneOf(ctx)), true) },
    { args: ['timestamp', 'interval'], ret: 'timestamp', fn: (v) => new TimestampV(addIv(v[0].us, v[1], 1, null), false) },
    { args: ['interval', 'timestamp'], ret: 'timestamp', fn: (v) => new TimestampV(addIv(v[1].us, v[0], 1, null), false) },
    { args: ['time', 'interval'], ret: 'time', fn: (v) => new TimeV(mod(v[0].us + (v[1].us % US_DAY), US_DAY)) },
    { args: ['interval', 'time'], ret: 'time', fn: (v) => new TimeV(mod(v[1].us + (v[0].us % US_DAY), US_DAY)) },
    { args: ['interval', 'interval'], ret: 'interval', fn: (v) => v[0].add(v[1]) },
  ]);
  op('-', [
    { args: ['date', 'int4'], ret: 'date', fn: (v) => dateOut(v[0].days - v[1]) },
    { args: ['date', 'date'], ret: 'int4', fn: (v) => { if (!fin(v[0].days) || !fin(v[1].days)) throw err('22008', 'cannot subtract infinite dates'); return v[0].days - v[1].days; } },
    { args: ['date', 'interval'], ret: 'timestamp', fn: (v) => new TimestampV(addIv(tsOf(v[0]).us, v[1], -1, null), false) },
    { args: ['timestamptz', 'interval'], ret: 'timestamptz', fn: (v, ctx) => new TimestampV(addIv(v[0].us, v[1], -1, zoneOf(ctx)), true) },
    { args: ['timestamp', 'interval'], ret: 'timestamp', fn: (v) => new TimestampV(addIv(v[0].us, v[1], -1, null), false) },
    { args: ['timestamptz', 'timestamptz'], ret: 'interval', fn: (v) => tsDiff(v[0], v[1]) },
    { args: ['timestamp', 'timestamp'], ret: 'interval', fn: (v) => tsDiff(v[0], v[1]) },
    { args: ['time', 'interval'], ret: 'time', fn: (v) => new TimeV(mod(v[0].us - (v[1].us % US_DAY), US_DAY)) },
    { args: ['time', 'time'], ret: 'interval', fn: (v) => new IntervalV(0, 0, v[0].us - v[1].us) },
    { args: ['interval', 'interval'], ret: 'interval', fn: (v) => v[0].sub(v[1]) },
  ]);
  op('*', [
    { args: ['interval', 'float8'], ret: 'interval', fn: (v) => ivMul(v[0], v[1]) },
    { args: ['float8', 'interval'], ret: 'interval', fn: (v) => ivMul(v[1], v[0]) },
  ]);
  op('/', { args: ['interval', 'float8'], ret: 'interval', fn: (v) => ivDiv(v[0], v[1]) });

  // ---- to_char, to_date and to_timestamp ----------------------------------------------------------------------------------
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const RM = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
  const KEYS = ['A.D.', 'A.M.', 'AD', 'AM', 'B.C.', 'BC', 'CC', 'DAY', 'DDD', 'DD', 'DY', 'Day', 'Dy', 'D', 'FF1', 'FF2', 'FF3', 'FF4', 'FF5', 'FF6', 'FX',
    'HH24', 'HH12', 'HH', 'IDDD', 'ID', 'IW', 'IYYY', 'IYY', 'IY', 'I', 'J', 'MI', 'MM', 'MONTH', 'MON', 'MS', 'Month', 'Mon', 'OF', 'P.M.', 'PM', 'Q',
    'RM', 'SSSSS', 'SSSS', 'SS', 'TZH', 'TZM', 'TZ', 'US', 'WW', 'W', 'Y,YYY', 'YYYY', 'YYY', 'YY', 'Y',
    'a.d.', 'a.m.', 'ad', 'am', 'b.c.', 'bc', 'cc', 'day', 'ddd', 'dd', 'dy', 'd', 'ff1', 'ff2', 'ff3', 'ff4', 'ff5', 'ff6', 'fx', 'hh24', 'hh12', 'hh',
    'iddd', 'id', 'iw', 'iyyy', 'iyy', 'iy', 'i', 'j', 'mi', 'mm', 'month', 'mon', 'ms', 'of', 'p.m.', 'pm', 'q', 'rm', 'sssss', 'ssss', 'ss', 'tzh', 'tzm', 'tz',
    'us', 'ww', 'w', 'y,yyy', 'yyyy', 'yyy', 'yy', 'y'];
  const fmtCache = new Map();
  /** a datetime template into nodes: { key, fm, th, TH } or { ch } */
  function parseFmt(fmt) {
    if (fmtCache.has(fmt)) return fmtCache.get(fmt);
    const nodes = [];
    for (let i = 0; i < fmt.length;) {
      if (fmt[i] === '"') {
        let j = i + 1;
        while (j < fmt.length && fmt[j] !== '"') { if (fmt[j] === '\\' && j + 1 < fmt.length) j++; nodes.push({ ch: fmt[j], quoted: true }); j++; }
        i = j + 1; continue;
      }
      if (fmt[i] === '\\' && i + 1 < fmt.length && fmt[i + 1] === '"') { nodes.push({ ch: '"' }); i += 2; continue; }
      let fm = false, j = i;
      for (;;) {
        if (/^fm/i.test(fmt.slice(j, j + 2))) { fm = true; j += 2; continue; }
        if (/^tm/i.test(fmt.slice(j, j + 2)) && KEYS.some((k) => fmt.startsWith(k, j + 2))) { j += 2; continue; }
        break;
      }
      const key = KEYS.find((k) => fmt.startsWith(k, j));
      if (!key) { if (fm && j > i) { i = j; continue; } nodes.push({ ch: fmt[i] }); i++; continue; }
      j += key.length;
      const n = { key, fm, tm: /tm/i.test(fmt.slice(i, j - key.length)) };
      if (fmt.startsWith('TH', j)) { n.th = 'TH'; j += 2; } else if (fmt.startsWith('th', j)) { n.th = 'th'; j += 2; }
      if (/^sp/i.test(fmt.slice(j, j + 2))) j += 2;
      nodes.push(n);
      i = j;
    }
    if (fmtCache.size > 200) fmtCache.clear();
    fmtCache.set(fmt, nodes);
    return nodes;
  }
  const ord = (n, up) => { const a = Math.abs(n) % 100, b = Math.abs(n) % 10; const s = a >= 11 && a <= 13 ? 'th' : b === 1 ? 'st' : b === 2 ? 'nd' : b === 3 ? 'rd' : 'th'; return up ? s.toUpperCase() : s; };
  const caseAs = (key, word) => (key === key.toUpperCase() && /[A-Z]/.test(key) && key.length > 1 && key[1] === key[1].toUpperCase() ? word.toUpperCase() : key[0] === key[0].toLowerCase() ? word.toLowerCase() : word);
  // zone abbreviations: the browser knows some under one English locale or another, a few more are listed here,
  // and the rest print as a numeric offset, as the tz database does
  const ABBR = { 'asia/tokyo': 'JST', 'asia/seoul': 'KST', 'asia/shanghai': 'CST', 'asia/taipei': 'CST', 'asia/hong_kong': 'HKT', 'europe/moscow': 'MSK', 'asia/karachi': 'PKT', 'asia/manila': 'PST', 'africa/johannesburg': 'SAST', 'asia/jakarta': 'WIB' };
  function zoneAbbrev(zone, us) {
    if (/^(utc|z|etc\/utc)$/i.test(zone)) return 'UTC';
    if (ABBR[zone.toLowerCase()]) return ABBR[zone.toLowerCase()];
    const o = off(zone, us) / US_MIN, num = (o < 0 ? '-' : '+') + pad(Math.trunc(Math.abs(o) / 60), 2) + (Math.abs(o) % 60 ? pad(Math.abs(o) % 60, 2) : '');
    if (/^[+-]\d/.test(zone)) return num;
    for (const loc of ['en-US', 'en-GB', 'en-IN', 'en-AU']) {
      try {
        const p = new Intl.DateTimeFormat(loc, { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date(us / 1000)).find((x) => x.type === 'timeZoneName');
        if (p && !/^(GMT|UTC)[+-−]/.test(p.value)) return p.value;
      } catch (e) { return num; }
    }
    return num;
  }
  /** fields for to_char: a timestamp (us local, utc and zone for tz), or an interval */
  function fieldsTs(local, utc, zone) {
    const p = parts(local), w = isoWeek(p.days);
    return Object.assign(p, { iy: w.year, iw: w.week, idow: w.dow, iddd: p.days - isoYearStart(w.year) + 1, zone, utc, offset: zone !== null ? off(zone, utc) : null });
  }
  function fieldsIv(iv) {
    const neg = iv.us < 0, a = Math.abs(iv.us);
    const sg = neg ? -1 : 1;
    return { interval: true, y: Math.trunc(iv.months / 12), m: iv.months % 12, d: iv.days, h: sg * fdiv(a, US_HOUR), mi: sg * fdiv(a % US_HOUR, US_MIN), s: sg * fdiv(a % US_MIN, US_SEC), us: sg * (a % US_SEC), tod: iv.us, days: iv.days, doy: iv.days, dow: 0 };
  }
  function toChar(f, fmt) {
    let out = '';
    for (const n of parseFmt(fmt)) {
      if (!n.key) { out += n.ch; continue; }
      const k = n.key, K2 = k.toUpperCase(), fm = n.fm;
      // as sprintf("%0*d"): the sign counts in the width, except for the time fields, which widen for it
      const num = (v, w, wide) => { const s = fm ? String(Math.abs(v)) : pad(v, v < 0 && !wide ? w - 1 : w); return (v < 0 ? '-' : '') + s + (n.th ? ord(v, n.th === 'TH') : ''); };
      const year = f.interval ? f.y : f.y > 0 ? f.y : 1 - f.y;
      const iyear = f.interval ? f.y : f.iy > 0 ? f.iy : 1 - f.iy;
      const h12 = f.h % 12 === 0 ? 12 : f.h % 12;
      switch (K2) {
        case 'HH': case 'HH12': out += num(f.interval ? (f.h % 12 === 0 ? 12 : f.h % 12) : h12, 2, true); break;
        case 'HH24': out += num(f.h, 2, true); break;
        case 'MI': out += num(f.mi, 2, true); break;
        case 'SS': out += num(f.s, 2, true); break;
        case 'MS': out += num(Math.trunc(f.us / 1000), 3); break;
        case 'US': out += num(f.us, 6); break;
        case 'FF1': case 'FF2': case 'FF3': case 'FF4': case 'FF5': case 'FF6': { const d = +K2[2]; out += num(Math.trunc(f.us / 10 ** (6 - d)), d); break; }
        case 'SSSS': case 'SSSSS': out += num(f.h * 3600 + f.mi * 60 + f.s, 0); break;
        case 'AM': case 'PM': out += (f.h % 24 >= 12 ? 'PM' : 'AM')[k[0] === 'a' || k[0] === 'p' ? 'toLowerCase' : 'toString'](); break;
        case 'A.M.': case 'P.M.': out += (f.h % 24 >= 12 ? 'P.M.' : 'A.M.')[k[0] === 'a' || k[0] === 'p' ? 'toLowerCase' : 'toString'](); break;
        case 'Y,YYY': out += String(Math.trunc(year / 1000)) + ',' + pad(year % 1000, 3) + (n.th ? ord(year, n.th === 'TH') : ''); break;
        case 'YYYY': out += num(year, 4); break;
        case 'YYY': out += num(year % 1000, 3); break;
        case 'YY': out += num(year % 100, 2); break;
        case 'Y': out += num(year % 10, 1); break;
        case 'IYYY': out += num(iyear, 4); break;
        case 'IYY': out += num(iyear % 1000, 3); break;
        case 'IY': out += num(iyear % 100, 2); break;
        case 'I': out += num(iyear % 10, 1); break;
        case 'BC': case 'AD': out += (f.y <= 0 && !f.interval ? 'BC' : 'AD')[k[0] === k[0].toLowerCase() ? 'toLowerCase' : 'toString'](); break;
        case 'B.C.': case 'A.D.': out += (f.y <= 0 && !f.interval ? 'B.C.' : 'A.D.')[k[0] === k[0].toLowerCase() ? 'toLowerCase' : 'toString'](); break;
        case 'MONTH': { if (f.interval && !f.m) break; const w = caseAs(k, MONTHS[(f.m + 11) % 12]); out += fm || n.tm ? w : w.padEnd(9, ' '); break; }
        case 'MON': { if (f.interval && !f.m) break; out += caseAs(k, MONTHS[(f.m + 11) % 12].slice(0, 3)); break; }
        case 'MM': out += num(f.m, 2); break;
        case 'DAY': { if (f.interval) break; const w = caseAs(k, DAYS[f.dow]); out += fm || n.tm ? w : w.padEnd(9, ' '); break; }
        case 'DY': { if (f.interval) break; out += caseAs(k, DAYS[f.dow].slice(0, 3)); break; }
        case 'DDD': out += num(f.doy, 3); break;
        case 'IDDD': out += num(f.iddd, 3); break;
        case 'DD': out += num(f.d, 2); break;
        case 'D': out += num(f.dow + 1, 1); break;
        case 'ID': out += num(f.idow, 1); break;
        case 'W': out += num(fdiv(f.d - 1, 7) + 1, 1); break;
        case 'WW': out += num(fdiv(f.doy - 1, 7) + 1, 2); break;
        case 'IW': out += num(f.iw, 2); break;
        case 'CC': out += num(f.interval ? Math.trunc(f.y / 100) : century(f.y), 2); break;
        case 'J': out += num(f.days + 2440588, 0); break;
        case 'Q': if (!f.interval || f.m) out += num(fdiv(f.m - 1, 3) + 1, 1); break;
        case 'RM': { if (f.interval && !f.m) break; const r = RM[(f.m + 11) % 12]; const w = k === 'rm' ? r.toLowerCase() : r; out += fm ? w : w.padEnd(4, ' '); break; }
        case 'TZ': if (f.offset !== null && f.offset !== undefined) { const a = zoneAbbrev(f.zone, f.utc); out += k === 'tz' ? a.toLowerCase() : a; } break;
        case 'TZH': if (f.offset !== null && f.offset !== undefined) { const o = f.offset / US_MIN; out += (o < 0 ? '-' : '+') + pad(Math.trunc(Math.abs(o) / 60), 2); } break;
        case 'TZM': if (f.offset !== null && f.offset !== undefined) out += pad(Math.abs(f.offset / US_MIN) % 60, 2); break;
        case 'OF': if (f.offset !== null && f.offset !== undefined) { const o = f.offset / US_MIN; out += (o < 0 ? '-' : '+') + pad(Math.trunc(Math.abs(o) / 60), 2) + (Math.abs(o) % 60 ? ':' + pad(Math.abs(o) % 60, 2) : ''); } break;
        case 'FX': break;
      }
    }
    return out;
  }
  F.fn('to_char', [
    { args: ['timestamptz', 'text'], ret: 'text', fn: (v, ctx) => { const t = v[0], z = zoneOf(ctx); if (!fin(t.us) || v[1] === '') return null; return toChar(fieldsTs(t.local(z), t.us, z), v[1]); } },
    { args: ['timestamp', 'text'], ret: 'text', fn: (v) => (fin(v[0].us) && v[1] !== '' ? toChar(fieldsTs(v[0].us, v[0].us, null), v[1]) : null) },
    { args: ['date', 'text'], ret: 'text', fn: (v) => (fin(v[0].days) && v[1] !== '' ? toChar(fieldsTs(v[0].days * US_DAY, 0, null), v[1]) : null) },
    { args: ['interval', 'text'], ret: 'text', fn: (v) => (v[1] === '' ? null : toChar(fieldsIv(v[0]), v[1])) },
    { args: ['time', 'text'], ret: 'text', fn: (v) => v[1] === '' ? null : toChar(fieldsIv(new IntervalV(0, 0, v[0].us)), v[1]) },
  ]);

  /** read a string against a template: the fields found, for to_date and to_timestamp */
  function parseWith(s, fmt) {
    const nodes = parseFmt(fmt);
    const f = {};
    let i = 0, fx = false;
    const isSep = (c) => c !== undefined && !/[\p{L}\p{N}]/u.test(c);
    const bad = (k, val, detail) => err('22007', 'invalid value "' + val + '" for "' + k + '"', { detail });
    const set = (name, k, v) => { if (f[name] !== undefined && f[name] !== v) throw err('22007', 'conflicting values for "' + k + '" field in formatting string', { detail: 'This value contradicts a previous setting for the same field type.' }); f[name] = v; };
    for (let ni = 0; ni < nodes.length; ni++) {
      const n = nodes[ni];
      if (!n.key) {
        if (fx) { i++; continue; }
        if (/\s/.test(n.ch)) { while (i < s.length && /\s/.test(s[i])) i++; continue; }
        if (n.quoted || !isSep(n.ch)) { i++; continue; }
        if (isSep(s[i])) i++;
        continue;
      }
      const K2 = n.key.toUpperCase();
      if (K2 === 'FX') { fx = true; continue; }
      if (!fx) while (i < s.length && /\s/.test(s[i])) i++;
      const next = nodes[ni + 1];
      const greedy = !next || !next.key || next.key.toUpperCase() === 'FX';
      const int = (len, name, lo, hi, signed) => {
        let j = i;
        if (signed && (s[j] === '-' || s[j] === '+')) j++;
        const st = j;
        while (j < s.length && /\d/.test(s[j]) && (greedy || n.fm || j - st < len)) j++;
        const txt = s.slice(i, j);
        if (j === st) throw bad(n.key, s.slice(i, i + len) || '', 'Value must be an integer.');
        i = j;
        const val = parseInt(txt, 10);
        if (lo !== undefined && (val < lo || val > hi)) {
          if (name === 'hour12') throw err('22007', 'hour "' + val + '" is invalid for the 12-hour clock', { hint: 'Use the 24-hour clock, or give an hour between 1 and 12.' });
          throw err('22008', 'date/time field value out of range: "' + s + '"');
        }
        set(name, n.key, val);
        if (n.th) i += 2;
        return txt.replace(/^[+-]/, '').length;
      };
      const word = (list, len, name, base) => {
        const rest = s.slice(i).toLowerCase();
        const idx = list.findIndex((w) => rest.startsWith((len ? w.slice(0, len) : w).toLowerCase()));
        if (idx < 0) throw bad(n.key, s.slice(i, i + (len || 9)).split(/\s/)[0], 'The given value did not match any of the allowed values for this field.');
        i += (len ? list[idx].slice(0, len) : list[idx]).length;
        if (name) set(name, n.key, idx + base);
      };
      switch (K2) {
        case 'YYYY': case 'IYYY': int(4, 'year', undefined, undefined, true); break;
        case 'Y,YYY': {
          const m = /^(\d+),(\d{3})/.exec(s.slice(i));
          if (!m) throw bad(n.key, s.slice(i, i + 5), 'Value must be an integer.');
          set('year', n.key, +m[1] * 1000 + +m[2]); i += m[0].length; break;
        }
        case 'YYY': case 'IYY': f.yLen = int(3, 'year'); break;
        case 'YY': case 'IY': f.yLen = int(2, 'year'); break;
        case 'Y': case 'I': f.yLen = int(1, 'year'); break;
        case 'MM': int(2, 'month', 1, 12); break;
        case 'MONTH': word(MONTHS, 0, 'month', 1); break;
        case 'MON': word(MONTHS, 3, 'month', 1); break;
        case 'RM': {
          const rest = s.slice(i).toUpperCase();
          let best = -1;
          RM.forEach((r, k) => { if (rest.startsWith(r) && (best < 0 || r.length > RM[best].length)) best = k; });
          if (best < 0) throw bad(n.key, s.slice(i, i + 4), 'The given value did not match any of the allowed values for this field.');
          i += RM[best].length; set('month', n.key, best + 1); break;
        }
        case 'DD': int(2, 'day', 1, 31); break;
        case 'DDD': case 'IDDD': int(3, 'doy', 1, 366); break;
        case 'D': case 'ID': int(1, 'dowN'); break;
        case 'DAY': word(DAYS, 0, null); break;
        case 'DY': word(DAYS, 3, null); break;
        case 'HH': case 'HH12': int(2, 'hour12', 1, 12); break;
        case 'HH24': int(2, 'hour', 0, 24); break;
        case 'MI': int(2, 'min', 0, 59); break;
        case 'SS': int(2, 'sec', 0, 60); break;
        case 'SSSS': case 'SSSSS': int(5, 'ssss', 0, 86399); break;
        case 'MS': { const st = i; int(3, 'msRaw'); const l = i - st; f.frac = (f.frac || 0) + f.msRaw * 10 ** (3 - l) * 1000; break; }
        case 'US': { const st = i; int(6, 'usRaw'); const l = i - st; f.frac = (f.frac || 0) + f.usRaw * 10 ** (6 - l); break; }
        case 'FF1': case 'FF2': case 'FF3': case 'FF4': case 'FF5': case 'FF6': { const d = +K2[2]; const st = i; int(d, 'ffRaw'); const l = i - st; f.frac = f.ffRaw * 10 ** (6 - l); break; }
        case 'AM': case 'PM': case 'A.M.': case 'P.M.': {
          const m = /^(a\.?m\.?|p\.?m\.?)/i.exec(s.slice(i));
          if (!m) throw bad(n.key, s.slice(i, i + 2), 'The given value did not match any of the allowed values for this field.');
          f.pm = /^p/i.test(m[1]); i += m[0].length; break;
        }
        case 'AD': case 'BC': case 'A.D.': case 'B.C.': {
          const m = /^(a\.?d\.?|b\.?c\.?)/i.exec(s.slice(i));
          if (!m) throw bad(n.key, s.slice(i, i + 2), 'The given value did not match any of the allowed values for this field.');
          f.bc = /^b/i.test(m[1]); i += m[0].length; break;
        }
        case 'CC': int(2, 'cc'); break;
        case 'J': int(7, 'julian'); break;
        case 'Q': int(1, 'q'); break;
        case 'W': int(1, 'w'); break;
        case 'WW': int(2, 'ww'); break;
        case 'IW': int(2, 'iw'); break;
        case 'TZH': int(2, 'tzh', -15, 15, true); f.tzhNeg = /^-/.test(s.slice(0, i).match(/[+-]?\d+$/)[0]); break;
        case 'TZM': int(2, 'tzm', 0, 59); break;
        case 'TZ': case 'OF': {
          const m = /^([+-]\d{1,2})(?::?(\d{2}))?|^[a-z]+/i.exec(s.slice(i));
          if (!m) throw err('22007', 'invalid value "' + s.slice(i, i + 3) + '" for "' + n.key + '"');
          if (m[1]) { f.tzh = +m[1]; f.tzhNeg = m[1][0] === '-'; f.tzm = +m[2] || 0; } else f.tzName = m[0];
          i += m[0].length; break;
        }
      }
    }
    return f;
  }
  /** fields to local microseconds (and an explicit offset in microseconds, if the input had one) */
  function assemble(f, s) {
    let year = f.year;
    if (year !== undefined && f.yLen !== undefined && f.yLen <= 3 && f.cc === undefined) {
      if (f.yLen === 2) year += year < 70 ? 2000 : 1900;
      else if (f.yLen === 3) year += year < 100 ? 2000 : 1000;
      else if (f.yLen === 1) year += 2000;
    }
    if (year === undefined && f.cc !== undefined) year = (f.cc - 1) * 100 + 1;
    // no year at all is year 0, that is 1 BC, as PostgreSQL leaves it
    if (year === undefined) year = 0;
    else if (f.bc) year = 1 - year;
    let days;
    if (f.julian !== undefined) days = f.julian - 2440588;
    else if (f.doy !== undefined && f.month === undefined && f.day === undefined) days = K.daysFromCivil(year, 1, 1) + f.doy - 1;
    else {
      const m = f.month || 1, d = f.day || 1;
      if (d > K.monthDays(year, m)) throw err('22008', 'date/time field value out of range: "' + s + '"');
      days = K.daysFromCivil(year, m, d);
    }
    let h = f.hour || 0;
    if (f.hour12 !== undefined) { h = f.hour12 % 12; if (f.pm) h += 12; }
    else if (f.pm && h < 12) h += 12;
    let t = f.ssss !== undefined ? f.ssss * US_SEC : h * US_HOUR + (f.min || 0) * US_MIN + (f.sec || 0) * US_SEC;
    t += Math.round(f.frac || 0);
    let offset = null;
    if (f.tzh !== undefined || f.tzm !== undefined) { const sign = f.tzhNeg ? -1 : 1; offset = sign * (Math.abs(f.tzh || 0) * US_HOUR + (f.tzm || 0) * US_MIN); }
    else if (f.tzName) offset = { zone: zoneName(f.tzName) };
    return { local: days * US_DAY + t, days, offset };
  }
  F.fn('to_date', { args: ['text', 'text'], ret: 'date', fn: (v) => new DateV(assemble(parseWith(v[0], v[1]), v[0]).days) });
  F.fn('to_timestamp', { args: ['text', 'text'], ret: 'timestamptz', fn: (v, ctx) => {
    const r = assemble(parseWith(v[0], v[1]), v[0]);
    if (r.offset === null) return new TimestampV(fromLocal(r.local, zoneOf(ctx)), true);
    if (typeof r.offset === 'object') return new TimestampV(fromLocal(r.local, r.offset.zone), true);
    return new TimestampV(r.local - r.offset, true);
  } });

  K.DT.toChar = toChar; K.DT.fieldsTs = fieldsTs; K.DT.age = age; K.DT.extract = extract;
  K.DT.justify = { hours: justifyHours, days: justifyDays, interval: justifyInterval };
})(typeof window !== 'undefined' ? window : globalThis);
