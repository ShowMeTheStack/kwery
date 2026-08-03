// Sharing a script as a link (the text compressed into the address, nothing sent anywhere), and opening files:
// a .sql script into a new tab, a CSV file into a table with COPY.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h } = UI;

  const b64url = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const unb64url = (s) => { const t = atob(s.replace(/-/g, '+').replace(/_/g, '/')); const u = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) u[i] = t.charCodeAt(i); return u; };
  async function squeeze(text) {
    const data = new TextEncoder().encode(text);
    if (typeof CompressionStream === 'undefined') return 'u' + b64url(data);
    const out = await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
    return 'z' + b64url(new Uint8Array(out));
  }
  async function unsqueeze(s) {
    const kind = s[0], bytes = unb64url(s.slice(1));
    if (kind === 'u') return new TextDecoder().decode(bytes);
    const out = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
    return new TextDecoder().decode(out);
  }

  const Share = UI.Share = {
    async link(app) {
      const text = app.editor.getValue();
      const sample = app.settings.sample;
      const hash = '#db=' + encodeURIComponent(sample) + '&q=' + (await squeeze(text));
      return location.origin + location.pathname + hash;
    },
    async dialog(app) {
      let url;
      try { url = await this.link(app); } catch (e) { UI.toast('This browser cannot make the link: ' + e.message, 'err'); return; }
      const input = h('input.inp', { value: url, readonly: true, style: { width: '100%' }, onfocus: (e) => e.target.select() });
      UI.dialog('Share this script', h('div', h('p', 'Anyone who opens this link gets this script in a new tab, on the ' + ((K.SAMPLES[app.settings.sample] || {}).title || 'empty') + ' database. The script is inside the link itself; nothing is uploaded.'), input, url.length > 8000 ? h('p.muted', 'The link is long (' + url.length + ' characters); some chat programs cut long links.') : null),
        { buttons: [{ label: 'Close' }, { label: 'Copy the link', primary: true, onclick: () => UI.copy(url) }] });
    },
    /** a link opened: put its script in a new tab */
    async open(app) {
      const m = /[#&]q=([A-Za-z0-9_-]+)/.exec(location.hash);
      if (!m) return;
      try {
        const text = await unsqueeze(m[1]);
        const db = /[#&]db=([^&]+)/.exec(location.hash);
        if (db && K.SAMPLES[decodeURIComponent(db[1])] && decodeURIComponent(db[1]) !== app.settings.sample) { app.settings.sample = decodeURIComponent(db[1]); app.saveSettings(); app.newDatabase(); }
        app.addTab('Shared', text);
        history.replaceState(null, '', location.pathname);
        UI.toast('The shared script is in a new tab');
      } catch (e) { UI.toast('This link is damaged: ' + e.message, 'err', 5000); }
    },
    /** open a file: .sql into a new tab, .csv into a table */
    pick(app) {
      const input = h('input', { type: 'file', accept: '.sql,.txt,.csv,text/csv,text/plain', style: { display: 'none' } });
      input.addEventListener('change', async () => {
        const f = input.files[0];
        input.remove();
        if (!f) return;
        const text = await f.text();
        if (/\.csv$/i.test(f.name)) this.csv(app, f.name.replace(/\.csv$/i, ''), text);
        else { app.addTab(f.name.replace(/\.(sql|txt)$/i, ''), text); UI.toast('Opened ' + f.name + ' in a new tab. Run all to run it.'); }
      });
      document.body.appendChild(input);
      input.click();
    },
    /** load CSV text into a new or existing table, guessing column types from the values */
    csv(app, name, text) {
      const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
      if (!lines.length) { UI.toast('The file is empty', 'err'); return; }
      const split = (l) => { const out = []; let cur = '', q = false; for (let i = 0; i < l.length; i++) { const c = l[i]; if (q) { if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; } else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return out; };
      const head = split(lines[0]).map((x, i) => K.lower(x.trim()).replace(/[^a-z0-9_]+/g, '_').replace(/^(\d)/, 'c$1') || 'col' + (i + 1));
      const rows = lines.slice(1).map(split);
      const guess = (i) => { const vals = rows.map((r) => r[i]).filter((v) => v !== undefined && v !== ''); if (vals.every((v) => /^-?\d{1,9}$/.test(v))) return 'integer'; if (vals.every((v) => /^-?\d+(\.\d+)?$/.test(v))) return 'numeric'; if (vals.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))) return 'date'; if (vals.every((v) => /^(true|false|t|f)$/i.test(v))) return 'boolean'; return 'text'; };
      const table = K.lower(name).replace(/[^a-z0-9_]+/g, '_') || 'imported';
      const ddl = 'create table ' + table + ' (\n' + head.map((c, i) => '  ' + c + ' ' + guess(i)).join(',\n') + '\n);';
      const area = h('textarea.inp', { rows: 8, style: { width: '100%', fontFamily: 'var(--mono)', height: 'auto' } }, ddl);
      UI.dialog('Import ' + name + '.csv', h('div', h('p', rows.length + ' rows, ' + head.length + ' columns. The table is created with these types (change them if needed), then the rows are loaded with COPY.'), area), {
        buttons: [{ label: 'Cancel' }, { label: 'Create and load', primary: true, onclick: () => {
          const s = app.session;
          try {
            s.exec(area.value);
            s.copyData = lines.slice(1).join('\n') + '\n';
            const r = s.exec('copy ' + table + ' from stdin with (format csv)');
            s.copyData = null;
            UI.toast(r[r.length - 1].tag.replace('COPY', 'Loaded') + ' rows into ' + table, 'ok');
            app.emit('schema'); app.renderPanel();
          } catch (e) { s.copyData = null; UI.toast(e.message, 'err', 6000); return false; }
        } }],
      });
    },
  };
  void Share;
})(typeof window !== 'undefined' ? window : globalThis);
