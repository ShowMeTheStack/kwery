// Minimal headless-Chrome driver over the DevTools protocol (no dependencies).
// Serves the repo over HTTP so the page behaves like it does on GitHub Pages.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';


const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch(opts = {}) {
  const server = createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';

    const f = join(root, p);
    if (!f.startsWith(root) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
    res.writeHead(200, { 'content-type': types[extname(f)] || 'application/octet-stream' });
    res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const userDir = opts.userDir || mkdtempSync(join(tmpdir(), 'cdp-'));
  const w = opts.width || 1400, h = opts.height || 900;
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDir}`, `--window-size=${w},${h}`,
    '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', '--mute-audio', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    proc.stderr.on('data', (d) => { buf += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) resolve(m[1]); });
    setTimeout(() => reject(new Error('chrome did not start')), 15000);
  });
  // never leave a browser behind, even if the caller forgets close() or crashes
  const killChrome = () => { try { proc.kill('SIGKILL'); } catch (e) { /* gone */ } if (!opts.userDir) try { rmSync(userDir, { recursive: true, force: true }); } catch (e) { /* ignore */ } };
  process.once('exit', killChrome);
  const httpBase = wsUrl.replace(/^ws/, 'http').replace(/\/devtools\/.*$/, '');
  const targets = await (await fetch(httpBase + '/json')).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  const logs = [];
  const listeners = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      logs.push({ type: msg.params.type, text: msg.params.args.map((a) => a.value !== undefined ? a.value : a.description).join(' ') });
    } else if (msg.method === 'Page.javascriptDialogOpening') {
      // never let "Leave site?" (beforeunload) or alert() dialogs block a headless run
      send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      logs.push({ type: 'exception', text: (d.exception && d.exception.description) || d.text });
    }
    for (const l of listeners) l(msg);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: !!opts.mobile });
  const api = {
    port, logs, send,
    url: `http://127.0.0.1:${port}/`,
    async goto(path) {
      const done = new Promise((r) => { const l = (m) => { if (m.method === 'Page.loadEventFired') { listeners.splice(listeners.indexOf(l), 1); r(); } }; listeners.push(l); });
      await send('Page.navigate', { url: `http://127.0.0.1:${port}/${path || ''}` });
      await done;
      await sleep(300);
    },
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('eval: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
      return r.result.value;
    },
    async waitFor(expr, timeout = 8000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        try { if (await api.eval(expr)) return true; } catch (e) { /* retry */ }
        await sleep(100);
      }
      throw new Error('timeout waiting for ' + expr);
    },
    async screenshot(file) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(file, Buffer.from(r.data, 'base64'));
    },
    async key(key, opts = {}) {
      const map = { Enter: [13, 'Enter', '\r'], F5: [116, 'F5'], F8: [119, 'F8'], F9: [120, 'F9'], F10: [121, 'F10'], Escape: [27, 'Escape'], ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'], Backspace: [8, 'Backspace'], Tab: [9, 'Tab'], F4: [115, 'F4'], F2: [113, 'F2'], F7: [118, 'F7'], F11: [122, 'F11'], F1: [112, 'F1'], F3: [114, 'F3'], F6: [117, 'F6'], Pause: [19, 'Pause'] };
      const m = map[key];
      const mods = (opts.shift ? 8 : 0) | (opts.ctrl ? 2 : 0) | (opts.alt ? 1 : 0);
      if (m) {
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: m[0], key: m[1], code: m[1] === 'Pause' ? 'Pause' : m[1], modifiers: mods });
        if (m[2]) await send('Input.dispatchKeyEvent', { type: 'char', text: m[2], key: m[1], modifiers: mods });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: m[0], key: m[1], code: m[1], modifiers: mods });
      } else {
        const code = /^[a-z]$/i.test(key) ? 'Key' + key.toUpperCase() : /^[0-9]$/.test(key) ? 'Digit' + key : key === ' ' ? 'Space' : '';
        const vk = /^[a-z0-9]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : key.charCodeAt(0);
        await send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: vk, key, code, text: opts.ctrl || opts.alt ? undefined : key, modifiers: mods });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: vk, key, code, modifiers: mods });
      }
    },
    async type(text) {
      for (const ch of text) {
        if (ch === '\n') await api.key('Enter');
        else await api.key(ch);
      }
    },
    async insertText(text) { await send('Input.insertText', { text }); },
    async click(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    },
    async clickSel(sel) {
      const r = await api.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
      if (!r) throw new Error('no element ' + sel);
      await api.click(r[0], r[1]);
    },
    sleep,
    async close() {
      try { ws.close(); } catch (e) { /* ignore */ }
      const gone = new Promise((r) => { if (proc.exitCode !== null) r(); else { proc.once('exit', r); setTimeout(r, 3000); } });
      proc.kill(); server.close(); process.removeListener('exit', killChrome);
      // a profile made just for this browser is thrown away, or the temp folder fills the disk
      if (!opts.userDir) { await gone; try { rmSync(userDir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
    },
  };
  return api;
}
