// Built-in system functions: pg_typeof, version, the current user and schema, settings (current_setting,
// set_config), num_nulls, transaction ids, pg_sleep, sequences (nextval, currval, setval, lastval),
// gen_random_uuid and pg_size_pretty.
(function (root) {
  'use strict';
  const K = root.K;
  const F = K.F;
  const B = K.T.BASE;
  const err = (code, msg, extra) => K.err(code, msg, extra);
  const session = (ctx) => (ctx && ctx.session) || K.currentSession || {};
  const settings = (ctx) => session(ctx).settings || {};

  const typeName = (t) => (!t ? 'unknown' : t.cat === 'A' ? typeName(t.elem) + '[]' : t.name);
  F.fn('pg_typeof', { args: ['any'], strict: false, ret: 'text', fn: (v, ctx, info) => typeName(info.at[0]) });
  F.fn('version', { args: [], ret: 'text', fn: () => 'Kwery 1.0 (PostgreSQL 17 dialect)' });

  const user = (ctx) => session(ctx).user || 'kwery';
  for (const name of ['current_user', 'session_user', 'current_role', 'user']) F.fn(name, { args: [], ret: 'text', fn: (v, ctx) => user(ctx) });
  /** the schemas of the search path that exist (pg_catalog is searched first unless listed) */
  const searchPath = (ctx) => {
    const ses = session(ctx);
    const raw = typeof ses.searchPath === 'function' ? ses.searchPath() : ses.searchPath || settings(ctx).search_path || 'public';
    const list = (Array.isArray(raw) ? raw : String(raw).split(',')).map((x) => String(x).trim().replace(/^"(.*)"$/, '$1')).map((x) => (x === '$user' ? user(ctx) : x)).filter(Boolean);
    const cat = (ctx && ctx.session && ctx.session.catalog) || (ctx && ctx.db && ctx.db.catalog);
    const exists = (n) => (cat && cat.schemas && cat.schemas.has ? cat.schemas.has(n) : n === 'public' || n === 'pg_catalog');
    return list.filter((x, i) => exists(x) && list.indexOf(x) === i);
  };
  F.fn('current_schema', { args: [], ret: 'text', fn: (v, ctx) => searchPath(ctx).filter((s) => s !== 'pg_catalog')[0] || null });
  F.fn('current_schemas', { args: ['bool'], ret: () => K.T.arrayOf(B.text), fn: (v, ctx) => {
    const p = searchPath(ctx);
    const own = p.filter((s) => s !== 'pg_catalog');
    return new K.ArrayV(v[0] ? ['pg_catalog'].concat(own) : own);
  } });
  const dbName = (ctx) => (ctx && ctx.db && ctx.db.name) || 'kwery';
  F.fn('current_catalog', { args: [], ret: 'text', fn: (v, ctx) => dbName(ctx) });
  F.fn('current_database', { args: [], ret: 'text', fn: (v, ctx) => dbName(ctx) });
  F.fn('pg_backend_pid', { args: [], ret: 'int4', fn: (v, ctx) => session(ctx).pid || session(ctx).id || 1 });

  // settings: the session's own values, with the fixed ones a PostgreSQL 17 server reports
  const FIXED = {
    server_version: '17.0', server_version_num: '170000', server_encoding: 'UTF8', client_encoding: 'UTF8', datestyle: 'ISO, MDY', intervalstyle: 'postgres',
    standard_conforming_strings: 'on', integer_datetimes: 'on', max_identifier_length: '63', block_size: '8192', lc_collate: 'C', lc_ctype: 'C',
    search_path: '"$user", public', application_name: '', transaction_isolation: 'read committed', default_transaction_isolation: 'read committed',
    timezone: 'UTC', extra_float_digits: '1', statement_timeout: '0', work_mem: '4MB', is_superuser: 'on',
  };
  const settingText = (x) => (x === true ? 'on' : x === false ? 'off' : Array.isArray(x) ? x.join(', ') : String(x));
  function getSetting(name, ctx) {
    const n = name.toLowerCase(), s = settings(ctx);
    if (n === 'transaction_isolation' && ctx && ctx.tx && ctx.tx.isolation) return String(ctx.tx.isolation).toLowerCase();
    if (n === 'transaction_read_only') return ctx && ctx.tx && ctx.tx.readOnly ? 'on' : 'off';
    const key = Object.keys(s).find((k) => k.toLowerCase() === n);
    if (key !== undefined && s[key] !== undefined && s[key] !== null) return ctx && ctx.session && ctx.session.settings === s && ctx.session.showValue ? ctx.session.showValue(key) : settingText(s[key]);
    if (n === 'timezone' && ctx && ctx.zone) return ctx.zone;
    if (Object.prototype.hasOwnProperty.call(FIXED, n)) return FIXED[n];
    return undefined;
  }
  F.fn('current_setting', { args: ['text', 'bool'], minArgs: 1, ret: 'text', fn: (v, ctx) => {
    const r = getSetting(v[0], ctx);
    if (r !== undefined) return r;
    if (v[1] === true) return null;
    throw err('42704', 'unrecognized configuration parameter "' + v[0] + '"');
  } });
  F.fn('set_config', { args: ['text', 'text', 'bool'], strict: false, volatile: true, ret: 'text', fn: (v, ctx) => {
    if (v[0] === null) throw err('22004', 'SET requires parameter name');
    const s = session(ctx), name = v[0].toLowerCase();
    if (typeof s.setSetting === 'function') s.setSetting(name, v[1], v[2] === true, ctx);
    else { if (!s.settings) s.settings = {}; s.settings[name] = v[1]; }
    const r = getSetting(name, ctx);
    return r === undefined ? v[1] : r;
  } });

  F.fn('num_nulls', { args: ['any', 'any'], variadic: true, strict: false, ret: 'int4', fn: (v) => v.filter((x) => x === null).length });
  F.fn('num_nonnulls', { args: ['any', 'any'], variadic: true, strict: false, ret: 'int4', fn: (v) => v.filter((x) => x !== null).length });

  // txid_current assigns an xid if the transaction has none yet, as PostgreSQL does
  const xid = (ctx, assign) => {
    const s = session(ctx);
    let r = null;
    if (assign && ctx && ctx.tx && ctx.db && typeof ctx.db.writeXid === 'function') { ctx.db.writeXid(ctx); r = ctx.tx.xid; }
    else if (typeof s.currentXid === 'function') r = s.currentXid(ctx);
    return r === null || r === undefined || r === 0 ? null : BigInt(r);
  };
  F.fn('txid_current', { args: [], volatile: true, ret: 'int8', fn: (v, ctx) => xid(ctx, true) });
  F.fn('pg_current_xact_id', { args: [], volatile: true, ret: 'int8', fn: (v, ctx) => xid(ctx, true) });
  F.fn('txid_current_if_assigned', { args: [], volatile: true, ret: 'int8', fn: (v, ctx) => xid(ctx, false) });
  F.fn('pg_sleep', { args: ['float8'], volatile: true, ret: 'void', fn: () => '' });
  F.fn('pg_sleep_for', { args: ['interval'], volatile: true, ret: 'void', fn: () => '' });

  // sequences live in the database
  const db = (ctx, what) => {
    const d = ctx && ctx.db;
    if (!d || typeof d[what] !== 'function') throw err('0A000', 'sequences are not available here');
    return d;
  };
  const seqName = (v) => String(v);
  const big = (x) => (x === null || x === undefined ? null : BigInt(x));
  for (const t of ['text', 'S']) {
    F.fn('nextval', { args: [t], volatile: true, ret: 'int8', fn: (v, ctx) => big(db(ctx, 'sequenceNext').sequenceNext(seqName(v[0]), ctx)) });
    F.fn('currval', { args: [t], volatile: true, ret: 'int8', fn: (v, ctx) => big(db(ctx, 'sequenceCurr').sequenceCurr(seqName(v[0]), ctx)) });
    F.fn('setval', { args: [t, 'int8', 'bool'], minArgs: 2, volatile: true, ret: 'int8', fn: (v, ctx) => big(db(ctx, 'sequenceSet').sequenceSet(seqName(v[0]), BigInt(v[1]), v.length > 2 ? v[2] : true, ctx)) ?? BigInt(v[1]) });
  }
  F.fn('lastval', { args: [], volatile: true, ret: 'int8', fn: (v, ctx) => big(db(ctx, 'sequenceLast').sequenceLast(ctx)) });

  F.fn('gen_random_uuid', { args: [], volatile: true, ret: 'uuid', fn: () => {
    const c = root.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    const b = Array.from({ length: 16 }, () => Math.floor(K.rng.next() * 256));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.map((x) => K.hex(x, 2)).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  } });

  // pg_size_pretty: bytes up to 10 kB, then kB, MB, GB, TB, PB with half rounding, as PostgreSQL prints sizes
  const UNITS = [['bytes', 10240n, false, 0], ['kB', 20479n, true, 10], ['MB', 20479n, true, 20], ['GB', 20479n, true, 30], ['TB', 20479n, true, 40], ['PB', 20479n, true, 50]];
  const halfRound = (x) => (x + (x < 0n ? -1n : 1n)) / 2n;
  function sizePretty(size) {
    for (let i = 0; i < UNITS.length; i++) {
      const [name, limit, round, bits] = UNITS[i];
      const abs = size < 0n ? -size : size;
      if (i === UNITS.length - 1 || abs < limit) return String(round ? halfRound(size) : size) + ' ' + name;
      const nb = UNITS[i + 1][3] - bits - (UNITS[i + 1][2] ? 1 : 0) + (round ? 1 : 0);
      size /= 1n << BigInt(nb);
    }
    return String(size);
  }
  F.fn('pg_size_pretty', [
    { args: ['int8'], ret: 'text', fn: (v) => sizePretty(BigInt(v[0])) },
    { args: [B.numeric], ret: 'text', fn: (v) => sizePretty(K.Decimal.of(v[0]).trunc(0).d) },
  ]);
  // enum support: the labels in their sort order
  const labels = (t) => (t.domain ? t.base : t).labels;
  F.fn('enum_first', { args: ['anyenum'], strict: false, ret: (w) => w[0], fn: (v, ctx, info) => labels(info.at[0])[0] });
  F.fn('enum_last', { args: ['anyenum'], strict: false, ret: (w) => w[0], fn: (v, ctx, info) => labels(info.at[0]).slice(-1)[0] });
  F.fn('enum_range', [
    { args: ['anyenum'], strict: false, ret: (w) => K.T.arrayOf(w[0]), fn: (v, ctx, info) => new K.ArrayV(labels(info.at[0]).slice()) },
    { args: ['anyenum', 'anyenum'], strict: false, ret: (w) => K.T.arrayOf(w[0]), fn: (v, ctx, info) => {
      const ls = labels(info.at[0]), a = v[0] === null ? 0 : ls.indexOf(v[0]), b = v[1] === null ? ls.length - 1 : ls.indexOf(v[1]);
      return new K.ArrayV(ls.slice(a, b + 1));
    } },
  ]);
})(typeof window !== 'undefined' ? window : globalThis);
