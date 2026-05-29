// DATE, TIME, TIMESTAMP, TIMESTAMP WITH TIME ZONE and INTERVAL, with PostgreSQL's input and output formats.
// Dates count days from 1970-01-01; times and timestamps count microseconds.
(function (root) {
  'use strict';
  const K = root.K;
  const US_DAY = 86400e6, US_HOUR = 3600e6, US_MIN = 60e6, US_SEC = 1e6;

  // days from civil date and back (proleptic Gregorian), after H. Hinnant
  function daysFromCivil(y, m, d) {
    y -= m <= 2 ? 1 : 0;
    const era = Math.floor(y / 400), yoe = y - era * 400;
    const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
  }
  function civilFromDays(z) {
    z += 719468;
    const era = Math.floor(z / 146097), doe = z - era * 146097;
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    const y = yoe + era * 400, doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153), d = doy - Math.floor((153 * mp + 2) / 5) + 1, m = mp + (mp < 10 ? 3 : -9);
    return [y + (m <= 2 ? 1 : 0), m, d];
  }
  const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const monthDays = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  const pad = (n, w) => String(Math.abs(n)).padStart(w || 2, '0');
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  // Julian day 0 (4714-11-24 BC) is the earliest date and timestamp
  const MIN_DAY = -2440588;
  class DateV {
    constructor(days) { this.days = days; } // may be +/-Infinity for 'infinity'
    static parse(text) {
      const t = String(text).trim().toLowerCase();
      if (t === 'infinity' || t === '+infinity') return new DateV(Infinity);
      if (t === '-infinity') return new DateV(-Infinity);
      if (t === 'epoch') return new DateV(0);
      if (t === 'today' || t === 'now') return new DateV(Math.floor(K.Clock.nowUs() / US_DAY));
      if (t === 'tomorrow') return new DateV(Math.floor(K.Clock.nowUs() / US_DAY) + 1);
      if (t === 'yesterday') return new DateV(Math.floor(K.Clock.nowUs() / US_DAY) - 1);
      let m = /^(\d{1,7})-(\d{1,2})-(\d{1,2})(\s+bc)?/.exec(t);
      let y, mo, d;
      if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; if (m[4]) y = 1 - y; }
      else if ((m = /^(\d{4,7})([./])(\d{1,2})\2(\d{1,2})$/.exec(t))) { y = +m[1]; mo = +m[3]; d = +m[4]; }
      else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t))) { mo = +m[1]; d = +m[2]; y = +m[3]; }
      else if ((m = /^(\d{1,2})[\s-]([a-z]{3})[a-z]*[\s-](\d{4})$/.exec(t))) { d = +m[1]; mo = MONTHS.indexOf(m[2]) + 1; y = +m[3]; }
      else if ((m = /^([a-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{4})$/.exec(t))) { mo = MONTHS.indexOf(m[1]) + 1; d = +m[2]; y = +m[3]; }
      else if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(t))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
      if (!y && y !== 0 || !(mo >= 1 && mo <= 12) || !(d >= 1 && d <= monthDays(y, mo))) {
        throw K.err(m ? K.STATE.datetimeOverflow : K.STATE.invalidDatetime, (m ? 'date/time field value out of range: "' : 'invalid input syntax for type date: "') + text + '"');
      }
      const days = daysFromCivil(y, mo, d);
      if (days < MIN_DAY || y > 5874897) throw K.err(K.STATE.datetimeOverflow, 'date out of range: "' + text + '"');
      return new DateV(days);
    }
    static of(y, m, d) { return new DateV(daysFromCivil(y, m, d)); }
    parts() { return civilFromDays(this.days); }
    toString() {
      if (this.days === Infinity) return 'infinity';
      if (this.days === -Infinity) return '-infinity';
      const [y, m, d] = civilFromDays(this.days);
      return (y <= 0 ? pad(1 - y, 4) : pad(y, 4)) + '-' + pad(m) + '-' + pad(d) + (y <= 0 ? ' BC' : '');
    }
    cmp(o) { return this.days < o.days ? -1 : this.days > o.days ? 1 : 0; }
    key() { return 'D' + this.days; }
    dow() { return ((this.days % 7) + 11) % 7; } // 0 = Sunday; 1970-01-01 was a Thursday
  }

  class TimeV {
    constructor(us) { this.us = us; }
    static parse(text) {
      const t = String(text).trim().toLowerCase();
      if (t === 'allballs') return new TimeV(0);
      const m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d+))?)?\s*(am|pm)?$/.exec(t);
      if (!m) throw K.err(K.STATE.invalidDatetime, 'invalid input syntax for type time: "' + text + '"');
      let h = +m[1];
      if (m[5]) { if (h < 1 || h > 12) throw K.err(K.STATE.datetimeOverflow, 'date/time field value out of range: "' + text + '"'); if (m[5] === 'pm' && h < 12) h += 12; if (m[5] === 'am' && h === 12) h = 0; }
      const mi = +m[2], s = m[3] ? +m[3] : 0, f = m[4] ? Math.round(+('0.' + m[4]) * US_SEC) : 0;
      if (h > 24 || mi > 59 || s > 60 || (h === 24 && (mi || s || f))) throw K.err(K.STATE.datetimeOverflow, 'date/time field value out of range: "' + text + '"');
      return new TimeV(h * US_HOUR + mi * US_MIN + s * US_SEC + f);
    }
    toString() { return fmtTime(this.us); }
    cmp(o) { return this.us < o.us ? -1 : this.us > o.us ? 1 : 0; }
    key() { return 't' + this.us; }
  }
  function fmtTime(us) {
    const h = Math.floor(us / US_HOUR), mi = Math.floor((us % US_HOUR) / US_MIN), s = Math.floor((us % US_MIN) / US_SEC), f = Math.round(us % US_SEC);
    return pad(h) + ':' + pad(mi) + ':' + pad(s) + (f ? '.' + String(f).padStart(6, '0').replace(/0+$/, '') : '');
  }

  /** TIMESTAMP (tz = false) and TIMESTAMPTZ (tz = true): microseconds since 1970-01-01 00:00 (UTC for tz) */
  class TimestampV {
    constructor(us, tz) { this.us = us; this.tz = !!tz; }
    static parse(text, tz, zone) {
      let t = String(text).trim();
      const lt = t.toLowerCase();
      if (lt === 'infinity' || lt === '+infinity') return new TimestampV(Infinity, tz);
      const bc = /\s+bc$/i.test(t);
      if (bc) t = t.replace(/\s+bc$/i, '');
      if (lt === '-infinity') return new TimestampV(-Infinity, tz);
      if (lt === 'epoch') return new TimestampV(0, tz);
      if (lt === 'now') return new TimestampV(K.Clock.nowUs(), tz);
      if (lt === 'today' || lt === 'tomorrow' || lt === 'yesterday') {
        const d = DateV.parse(lt).days;
        return new TimestampV(tz ? Zone.fromLocal(zone, d * US_DAY) : d * US_DAY, tz);
      }
      let m = /^(.+?)(?:[ T](\d{1,2}:\d{1,2}(?::\d{1,2}(?:\.\d+)?)?(?:\s*[ap]m)?))?\s*(z|utc|[+-]\d{1,2}(?::?\d{2})?|[a-z]+\/[a-z_]+(?:\/[a-z_]+)?)?$/i.exec(t);
      // a bare date such as 2024-03-05: the -05 is the day, not a zone offset
      if (m && m[2] === undefined && m[3] && /^[+-]/.test(m[3])) m = [t, t, undefined, undefined];
      if (!m) throw K.err(K.STATE.invalidDatetime, 'invalid input syntax for type timestamp: "' + text + '"');
      let date;
      try { date = DateV.parse(m[1] + (bc ? ' bc' : '')); } catch (e) { throw K.err(e.code, String(e.message).replace('type date', 'type timestamp')); }
      const time = m[2] ? TimeV.parse(m[2]).us : 0;
      let us = date.days * US_DAY + time;
      if (tz) us = m[3] && /^([+-]|z$|utc$|gmt$)/i.test(m[3]) ? us - Zone.parseOffset(m[3], us) : Zone.fromLocal(m[3] || zone, us);
      if (date.days >= 106762940 || us < MIN_DAY * US_DAY) throw K.err(K.STATE.datetimeOverflow, 'timestamp out of range: "' + text + '"');
      return new TimestampV(us, tz);
    }
    /** the local wall-clock microseconds (for a tz value, in the given zone) */
    local(zone) { return this.tz ? this.us + Zone.offsetUs(zone, this.us) : this.us; }
    toString(zone) {
      if (this.us === Infinity) return 'infinity';
      if (this.us === -Infinity) return '-infinity';
      const l = this.local(zone);
      const days = Math.floor(l / US_DAY), rest = l - days * US_DAY;
      let s = new DateV(days).toString().replace(' BC', '') + ' ' + fmtTime(rest);
      if (this.tz) {
        const off = Math.round(Zone.offsetUs(zone, this.us) / US_SEC), a = Math.abs(off);
        s += (off < 0 ? '-' : '+') + pad(Math.floor(a / 3600)) + (a % 3600 ? ':' + pad(Math.floor(a / 60) % 60) : '') + (a % 60 ? ':' + pad(a % 60) : '');
      }
      return s + (new DateV(days).parts()[0] <= 0 ? ' BC' : '');
    }
    cmp(o) { return this.us < o.us ? -1 : this.us > o.us ? 1 : 0; }
    key() { return 'T' + this.us; }
  }

  /** INTERVAL: months, days and microseconds kept apart, because a month is not a fixed number of days */
  class IntervalV {
    constructor(months, days, us) { this.months = months | 0; this.days = days | 0; this.us = us || 0; }
    /** +infinity or -infinity (PostgreSQL 17): every field at its extreme */
    static inf(sign) { const iv = new IntervalV(0, 0, 0); iv.months = iv.days = iv.us = sign * Infinity; return iv; }
    infSign() { return this.us === Infinity ? 1 : this.us === -Infinity ? -1 : 0; }
    /** field: the qualifier of INTERVAL '...' DAY TO SECOND, whose last field gives a bare number its unit */
    static parse(text, field) {
      let t = String(text).trim().toLowerCase();
      if (t === 'infinity' || t === '+infinity') return IntervalV.inf(1);
      if (t === '-infinity') return IntervalV.inf(-1);
      if (t.startsWith('p')) return IntervalV.parseIso(t, text);
      let months = 0, days = 0, us = 0, any = false;
      const ago = /\bago$/.test(t);
      t = t.replace(/\bago$/, '').replace(/^@/, '').trim();
      // '- 1 day' is -1 day; a bare number before a time ('3 4:05') counts days
      t = t.replace(/([+-])\s+(?=\d)/g, '$1').replace(/(^|\s)([+-]?\d+)\s+(?=[+-]?\d+:)/g, '$1$2 days ');
      const re = /([+-]?\d+(?:\.\d+)?)\s*(millennium|millennia|century|centuries|decades?|years?|y|mons?|months?|weeks?|w|days?|d|hours?|h|minutes?|mins?|m|seconds?|secs?|s|milliseconds?|ms|microseconds?|us)\b|([+-]?\d+):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?|([+-]?\d+)-(\d+)(?![\d:])/g;
      const range = () => { throw K.err('22015', 'interval field value out of range: "' + text + '"'); };
      let m, rest = t;
      while ((m = re.exec(t))) {
        any = true;
        rest = rest.replace(m[0], '');
        if (m[6] !== undefined) { const sign = m[6].startsWith('-') ? -1 : 1; if (+m[7] > 11) range(); months += sign * (Math.abs(+m[6]) * 12 + +m[7]); continue; }
        if (m[3] !== undefined) {
          const sign = m[3].startsWith('-') ? -1 : 1;
          if (+m[4] > 59 || m[5] && parseFloat(m[5]) >= 60) range();
          // in a MINUTE TO SECOND interval, 4:03 is minutes and seconds
          if (field === 'minute to second' && m[5] === undefined) { us += sign * (Math.abs(+m[3]) * US_MIN + +m[4] * US_SEC); continue; }
          us += sign * (Math.abs(+m[3]) * US_HOUR + +m[4] * US_MIN + (m[5] ? Math.round(parseFloat(m[5]) * US_SEC) : 0));
          continue;
        }
        const n = parseFloat(m[1]), u = m[2];
        if (/^(millennium|millennia)/.test(u)) months += Math.round(n * 12000);
        else if (/^centur/.test(u)) months += Math.round(n * 1200);
        else if (/^decade/.test(u)) months += Math.round(n * 120);
        else if (/^(years?|y)$/.test(u)) months += Math.round(n * 12);
        else if (/^(mons?|months?)$/.test(u)) { months += Math.trunc(n); days += Math.round((n % 1) * 30); }
        else if (/^(weeks?|w)$/.test(u)) { days += Math.trunc(n * 7); us += Math.round((n * 7 % 1) * US_DAY); }
        else if (/^(days?|d)$/.test(u)) { days += Math.trunc(n); us += Math.round((n % 1) * US_DAY); }
        else if (/^(hours?|h)$/.test(u)) us += Math.round(n * US_HOUR);
        else if (/^(minutes?|mins?|m)$/.test(u)) us += Math.round(n * US_MIN);
        else if (/^(seconds?|secs?|s)$/.test(u)) us += Math.round(n * US_SEC);
        else if (/^(milliseconds?|ms)$/.test(u)) us += Math.round(n * 1000);
        else us += Math.round(n);
      }
      // a number without a unit takes the last field of the qualifier, seconds by default
      const bare = rest.replace(/[\s,]/g, '');
      if (/^[+-]?\d+(\.\d+)?$/.test(bare)) {
        const n = parseFloat(bare), low = field ? field.split(' ').pop() : 'second';
        if (low === 'year') months += Math.round(n * 12);
        else if (low === 'month') months += Math.round(n);
        else if (low === 'day') { days += Math.trunc(n); us += Math.round((n % 1) * US_DAY); }
        else us += Math.round(n * (low === 'hour' ? US_HOUR : low === 'minute' ? US_MIN : US_SEC));
        any = true; rest = '';
      }
      if (!any || rest.replace(/[\s,]/g, '')) throw K.err(K.STATE.invalidDatetime, 'invalid input syntax for type interval: "' + text + '"');
      if (Math.abs(months) > 2147483647 || Math.abs(days) > 2147483647) range();
      const iv = new IntervalV(months, days, us);
      return ago ? iv.neg() : iv;
    }
    static parseIso(t, text) {
      const m = /^p(?:(\d+)y)?(?:(\d+)m)?(?:(\d+)w)?(?:(\d+)d)?(?:t(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?)?$/.exec(t);
      if (!m) throw K.err(K.STATE.invalidDatetime, 'invalid input syntax for type interval: "' + text + '"');
      return new IntervalV((+m[1] || 0) * 12 + (+m[2] || 0), (+m[3] || 0) * 7 + (+m[4] || 0), (+m[5] || 0) * US_HOUR + (+m[6] || 0) * US_MIN + Math.round((parseFloat(m[7]) || 0) * US_SEC));
    }
    add(o) {
      const a = this.infSign(), b = o.infSign();
      if (a || b) { if (a && b && a !== b) throw K.err(K.STATE.datetimeOverflow, 'interval out of range'); return IntervalV.inf(a || b); }
      const r = [this.months + o.months, this.days + o.days, this.us + o.us];
      if (Math.abs(r[0]) > 2147483647 || Math.abs(r[1]) > 2147483647 || Math.abs(r[2]) >= 9223372036854775807) throw K.err(K.STATE.datetimeOverflow, 'interval out of range');
      return new IntervalV(r[0], r[1], r[2]);
    }
    sub(o) { return this.add(o.neg()); }
    neg() { return this.infSign() ? IntervalV.inf(-this.infSign()) : new IntervalV(-this.months, -this.days, -this.us); }
    mul(f) {
      // PostgreSQL spills fractional months into days and fractional days into time
      const m = this.months * f, d = this.days * f + (m % 1) * 30, u = this.us * f + (d % 1) * US_DAY;
      return new IntervalV(Math.trunc(m), Math.trunc(d), Math.round(u));
    }
    /** a single number for comparing intervals, with a month as 30 days, as PostgreSQL does */
    total() { return this.infSign() ? this.us : (this.months * 30 + this.days) * US_DAY + this.us; }
    cmp(o) { const a = this.total(), b = o.total(); return a < b ? -1 : a > b ? 1 : 0; }
    key() { return 'I' + this.total(); }
    justify() {
      let us = this.us, days = this.days + Math.trunc(us / US_DAY); us %= US_DAY;
      let months = this.months + Math.trunc(days / 30); days %= 30;
      return new IntervalV(months, days, us);
    }
    toString() {
      if (this.infSign()) return this.infSign() > 0 ? 'infinity' : '-infinity';
      // as PostgreSQL's EncodeInterval: a positive part after a negative one is written with an explicit +
      const parts = [];
      let before = false;
      const part = (v, unit) => { if (!v) return; parts.push((before && v > 0 ? '+' : '') + v + ' ' + unit + (v !== 1 ? 's' : '')); before = v < 0; };
      part(Math.trunc(this.months / 12), 'year');
      part(this.months % 12, 'mon');
      part(this.days, 'day');
      if (this.us || !parts.length) {
        const neg = this.us < 0, a = Math.abs(this.us);
        parts.push((neg ? '-' : before ? '+' : '') + fmtTime(a).replace(/^(\d+)/, (h) => String(Math.floor(a / US_HOUR)).padStart(2, '0')));
      }
      return parts.join(' ');
    }
  }

  /** time zones: fixed offsets, UTC, and named zones through the browser's own tz database (Intl) */
  const Zone = {
    parseOffset(s, us) {
      s = s.toLowerCase();
      if (s === 'z' || s === 'utc' || s === 'gmt') return 0;
      const m = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(s);
      if (m) return (m[1] === '-' ? -1 : 1) * ((+m[2]) * US_HOUR + (+m[3] || 0) * US_MIN);
      return Zone.offsetUs(s, us);
    },
    /** wall-clock microseconds in a zone to the instant: a time that falls twice (fall back) takes the offset after
     *  the transition, one that never happens (spring forward) the offset before it, as PostgreSQL does */
    fromLocal(zone, local) {
      if (!Number.isFinite(local)) return local;
      const before = Zone.offsetUs(zone, local - US_DAY), after = Zone.offsetUs(zone, local + US_DAY);
      if (Zone.offsetUs(zone, local - after) === after) return local - after;
      return local - before;
    },
    valid(zone) { try { Zone.offsetUs(zone, 0); return true; } catch (e) { return false; } },
    /** offset in microseconds of the zone at the instant us (UTC) */
    offsetUs(zone, us) {
      if (!zone || /^(utc|gmt|z|etc\/utc)$/i.test(zone)) return 0;
      // @+05:30 is an internal fixed offset east of Greenwich; a user's +05:30, UTC+5 or <+05>-05 is POSIX, west
      const iso = /^@([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(zone);
      if (iso) return (iso[1] === '-' ? -1 : 1) * ((+iso[2]) * US_HOUR + (+iso[3] || 0) * US_MIN);
      const posix = /^(?:<[^>]*>|utc|gmt)?([+-]?)(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?$/i.exec(zone);
      if (posix) return (posix[1] === '-' ? 1 : -1) * ((+posix[2]) * US_HOUR + (+posix[3] || 0) * US_MIN + (+posix[4] || 0) * US_SEC);
      if (!Number.isFinite(us)) return 0;
      try {
        const f = Zone.fmt(zone);
        const ms = Math.round(us / 1000);
        const p = Object.fromEntries(f.formatToParts(new Date(ms)).filter((x) => x.type !== 'literal').map((x) => [x.type, +x.value]));
        const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
        return (asUtc - Math.floor(ms / 1000) * 1000) * 1000;
      } catch (e) { throw K.err(K.STATE.invalidParameter, 'time zone "' + zone + '" not recognized'); }
    },
    cache: new Map(),
    fmt(zone) {
      if (!Zone.cache.has(zone)) Zone.cache.set(zone, new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
      return Zone.cache.get(zone);
    },
  };

  /** the clock: real time, or frozen for tests and step-by-step runs */
  K.Clock = { frozen: null, nowUs() { return this.frozen !== null ? this.frozen : Date.now() * 1000; }, now() { return this.nowUs(); } };

  Object.assign(K, { DateV, TimeV, TimestampV, IntervalV, Zone, daysFromCivil, civilFromDays, monthDays, isLeap, US_DAY, US_HOUR, US_MIN, US_SEC, fmtTime });
})(typeof window !== 'undefined' ? window : globalThis);
