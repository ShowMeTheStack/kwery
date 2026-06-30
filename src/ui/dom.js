// The page's small toolkit: an element builder, icons, toasts, dialogs, menus, splitters, stored preferences,
// and the formatting of values for display.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI = K.UI || {};

  /** h('div.cls#id', {attr}, ...children) */
  UI.h = function (sel, attrs, ...kids) {
    const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(sel) || [];
    const el = document.createElement(m[1] || 'div');
    (m[2] || '').replace(/([.#])([\w-]+)/g, (_, k, v) => { if (k === '.') el.classList.add(v); else el.id = v; });
    if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'value') el.value = v;
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    const add = (k) => {
      if (k === null || k === undefined || k === false) return;
      if (Array.isArray(k)) { k.forEach(add); return; }
      el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
    };
    kids.forEach(add);
    return el;
  };
  const h = UI.h;
  /** an SVG element: s('rect', {x, y, ...}, ...children) */
  UI.s = function (tag, attrs, ...kids) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs && (attrs instanceof Node || Array.isArray(attrs) || typeof attrs !== 'object')) { kids.unshift(attrs); attrs = null; }
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'class') el.setAttribute('class', v);
      else el.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  };

  // ---- icons: 20x20 strokes --------------------------------------------------------------------------
  const P = {
    run: '<path d="M6 3.5l10 6.5-10 6.5z" fill="currentColor" stroke="none"/>',
    runAll: '<path d="M3 3.5l8 6.5-8 6.5z" fill="currentColor" stroke="none"/><path d="M11 3.5l6 6.5-6 6.5"/>',
    pause: '<rect x="5" y="4" width="3.5" height="12" rx="1" fill="currentColor" stroke="none"/><rect x="11.5" y="4" width="3.5" height="12" rx="1" fill="currentColor" stroke="none"/>',
    stop: '<rect x="5" y="5" width="10" height="10" rx="1.5" fill="currentColor" stroke="none"/>',
    step: '<path d="M4 4v12"/><path d="M8 4l8 6-8 6z" fill="currentColor" stroke="none"/>',
    stepBack: '<path d="M16 4v12"/><path d="M12 4l-8 6 8 6z" fill="currentColor" stroke="none"/>',
    first: '<path d="M4 4v12"/><path d="M15 4l-8 6 8 6z"/>',
    last: '<path d="M16 4v12"/><path d="M5 4l8 6-8 6z"/>',
    db: '<ellipse cx="10" cy="4.5" rx="6.5" ry="2.5"/><path d="M3.5 4.5v11c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-11"/><path d="M3.5 10c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5"/>',
    table: '<rect x="2.5" y="3.5" width="15" height="13" rx="2"/><path d="M2.5 8h15M2.5 12.3h15M8 8v8.5"/>',
    view: '<rect x="2.5" y="3.5" width="15" height="13" rx="2" stroke-dasharray="2.5 2"/><path d="M2.5 8h15"/>',
    key: '<circle cx="6.5" cy="10" r="3.5"/><path d="M10 10h7.5M14.5 10v3M17 10v2"/>',
    index: '<path d="M10 3v4M10 7l-5 4M10 7l5 4"/><rect x="2.5" y="11" width="5" height="5" rx="1"/><rect x="12.5" y="11" width="5" height="5" rx="1"/><rect x="7.5" y="1.5" width="5" height="3" rx="1"/>',
    seq: '<path d="M4 15l3-10M9 15l3-10M3 8h11M2.5 12h11"/>',
    fn: '<path d="M12.5 3.5c-2 0-2.5 1.2-3 3.5l-1.6 7c-.5 2.3-1 3.5-3 3.5M5.5 8.5h7"/>',
    type: '<path d="M4 5h12M10 5v11"/>',
    col: '<path d="M6 4v12M14 4v12M6 8h8"/>',
    schema: '<path d="M2.5 5h6l2 2h7v9h-15z"/>',
    plus: '<path d="M10 4v12M4 10h12"/>',
    x: '<path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/>',
    chev: '<path d="M7.5 5l5 5-5 5"/>',
    chevDown: '<path d="M5 7.5l5 5 5-5"/>',
    cog: '<path d="M8.6 2.5h2.8l.4 2.1 1.6.9 2-.8 1.4 2.4-1.6 1.4v1.8l1.6 1.4-1.4 2.4-2-.8-1.6.9-.4 2.1H8.6l-.4-2.1-1.6-.9-2 .8-1.4-2.4 1.6-1.4V9.1L3.2 7.7l1.4-2.4 2 .8 1.6-.9z"/><circle cx="10" cy="10" r="2.4"/>',
    sun: '<circle cx="10" cy="10" r="3.4"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4"/>',
    moon: '<path d="M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8z"/>',
    help: '<circle cx="10" cy="10" r="7.5"/><path d="M7.7 7.7a2.4 2.4 0 1 1 3.3 2.2c-.6.3-1 .8-1 1.6v.4"/><circle cx="10" cy="14.6" r=".8" fill="currentColor"/>',
    learn: '<path d="M2 7.5L10 3.5l8 4-8 4z"/><path d="M5.5 9.5v4c1.2 1.3 2.7 2 4.5 2s3.3-.7 4.5-2v-4"/>',
    book: '<path d="M3 4h5a2 2 0 0 1 2 2v11a2 2 0 0 0-2-2H3zM17 4h-5a2 2 0 0 0-2 2v11a2 2 0 0 1 2-2h5z"/>',
    check: '<path d="M4 10.5l4 4 8-9"/>',
    tasks: '<path d="M8 5h9M8 10h9M8 15h9"/><path d="M3 5l1 1 2-2M3 10l1 1 2-2M3 15l1 1 2-2"/>',
    plan: '<rect x="7.5" y="2" width="5" height="4" rx="1"/><rect x="2" y="14" width="5" height="4" rx="1"/><rect x="13" y="14" width="5" height="4" rx="1"/><path d="M10 6v4M10 10H4.5v4M10 10h5.5v4"/>',
    page: '<path d="M5 2.5h7l3.5 3.5v11.5H5z"/><path d="M7.5 9h5M7.5 12h5M7.5 15h3"/>',
    frames: '<rect x="2.5" y="3" width="6.5" height="6" rx="1"/><rect x="11" y="3" width="6.5" height="6" rx="1"/><rect x="2.5" y="11" width="6.5" height="6" rx="1"/><rect x="11" y="11" width="6.5" height="6" rx="1" fill="currentColor" fill-opacity=".25"/>',
    tree: '<circle cx="10" cy="4" r="2"/><circle cx="5" cy="15" r="2"/><circle cx="15" cy="15" r="2"/><path d="M9 6l-3 7M11 6l3 7"/>',
    lock: '<rect x="4" y="9" width="12" height="8.5" rx="2"/><path d="M6.5 9V6.5a3.5 3.5 0 0 1 7 0V9"/>',
    log: '<path d="M4 3.5h12v13H4z"/><path d="M7 7h6M7 10h6M7 13h4"/>',
    disk: '<circle cx="10" cy="10" r="7.5"/><circle cx="10" cy="10" r="2"/><path d="M10 2.5v5.5"/>',
    er: '<rect x="1.5" y="7" width="6" height="6" rx="1"/><path d="M14.5 6l4 4-4 4-4-4z"/><path d="M7.5 10h3"/>',
    sigma: '<path d="M15 4H5l5 6-5 6h10"/>',
    flask: '<path d="M8 2.5h4M8.5 2.5v5L3.5 16a1.5 1.5 0 0 0 1.3 2h10.4a1.5 1.5 0 0 0 1.3-2l-5-8.5v-5"/>',
    nodes: '<circle cx="4" cy="10" r="2.2"/><circle cx="16" cy="4.5" r="2.2"/><circle cx="16" cy="15.5" r="2.2"/><path d="M6 9l8-3.5M6 11l8 3.5M16 6.7v6.6"/>',
    grid: '<rect x="3" y="3" width="14" height="14" rx="2"/><path d="M3 8h14M3 12.5h14M8 3v14M12.5 3v14"/>',
    menu: '<path d="M3.5 6h13M3.5 10h13M3.5 14h13"/>',
    more: '<circle cx="4.5" cy="10" r="1.3" fill="currentColor"/><circle cx="10" cy="10" r="1.3" fill="currentColor"/><circle cx="15.5" cy="10" r="1.3" fill="currentColor"/>',
    download: '<path d="M10 3v10M6 9.5l4 4 4-4M3.5 16.5h13"/>',
    upload: '<path d="M10 14V4M6 7.5l4-4 4 4M3.5 16.5h13"/>',
    share: '<circle cx="15" cy="4.5" r="2"/><circle cx="5" cy="10" r="2"/><circle cx="15" cy="15.5" r="2"/><path d="M7 9l6-3.5M7 11l6 3.5"/>',
    trash: '<path d="M4 6h12M8 6V3.5h4V6M5.5 6l1 11h7l1-11"/>',
    refresh: '<path d="M16 10a6 6 0 1 1-2-4.5"/><path d="M17 3v4h-4"/>',
    split: '<rect x="2.5" y="3.5" width="15" height="13" rx="2"/><path d="M10 3.5v13"/>',
    max: '<path d="M3 8V3h5M12 3h5v5M17 12v5h-5M8 17H3v-5"/>',
    search: '<circle cx="8.5" cy="8.5" r="5"/><path d="M12.5 12.5l4.5 4.5"/>',
    bolt: '<path d="M11 2L4 11.5h5L8 18l7-9.5h-5z"/>',
    clock: '<circle cx="10" cy="10" r="7.5"/><path d="M10 5.5V10l3 2"/>',
    eye: '<path d="M1.5 10S4.5 4.5 10 4.5 18.5 10 18.5 10 15.5 15.5 10 15.5 1.5 10 1.5 10z"/><circle cx="10" cy="10" r="2.3"/>',
    flag: '<path d="M4.5 18V3"/><path d="M4.5 3.5h10l-2 3.5 2 3.5h-10"/>',
    warn: '<path d="M10 2.5l8 14.5H2z"/><path d="M10 8v4"/><circle cx="10" cy="14.6" r=".8" fill="currentColor"/>',
    info: '<circle cx="10" cy="10" r="7.5"/><path d="M10 9v5"/><circle cx="10" cy="6.2" r=".8" fill="currentColor"/>',
    copy: '<rect x="6.5" y="6.5" width="10" height="10" rx="2"/><path d="M13.5 6.5v-2a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 4.5V12A1.5 1.5 0 0 0 5 13.5h1.5"/>',
    format: '<path d="M3 5h14M3 9h9M3 13h12M3 17h7"/>',
    history: '<path d="M3.5 10a6.5 6.5 0 1 0 2-4.7"/><path d="M3 3.5v3.5h3.5M10 6.5V10l2.5 2"/>',
    screen: '<rect x="2" y="3" width="16" height="11" rx="1.5"/><path d="M7 17h6M10 14v3"/>',
    crash: '<path d="M10 2l1.6 4.3L16 4.7l-1.8 4.4L18.5 11l-4.4 1.3L15 17l-4.2-2.4L8 18.5 7.4 14 2.5 14.5l3.3-3.3L2 7.8l4.6-.4z"/>',
    users: '<circle cx="7" cy="7" r="3"/><path d="M1.5 17c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5"/><circle cx="14" cy="6" r="2.4"/><path d="M13.5 11.5c2.4 0 4.3 1.3 5 3.8"/>',
    terminal: '<rect x="2" y="3" width="16" height="14" rx="3"/><path d="M5.5 8l3 2.2-3 2.2M10.5 13h4"/>',
  };
  UI.ICONS = P;
  UI.icon = function (name, cls) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 20 20');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.6');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
    s.innerHTML = P[name] || '';
    return s;
  };
  /** a toolbar button: icon, label (shown when there is room), title and action */
  UI.btn = function (icon, label, title, onclick, cls) {
    const b = h('button.btn' + (cls ? '.' + cls.split(' ').join('.') : ''), { type: 'button', title: title || label || '', 'aria-label': title || label, onclick }, icon ? UI.icon(icon) : null, label ? h('span.bl', label) : null);
    return b;
  };

  // ---- toasts ---------------------------------------------------------------------------------------
  let toastBox = null;
  UI.toast = function (msg, kind, ms) {
    if (!toastBox) { toastBox = h('div.toasts', { role: 'status', 'aria-live': 'polite' }); document.body.appendChild(toastBox); }
    const t = h('div.toast' + (kind ? '.' + kind : ''), msg);
    toastBox.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms || 2600);
  };

  // ---- dialogs --------------------------------------------------------------------------------------
  /** a modal dialog; returns { el, close } */
  UI.dialog = function (title, body, opts) {
    opts = opts || {};
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); if (opts.onClose) opts.onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    const head = h('div.dlg-head', h('h2', title), h('button.icon-btn', { type: 'button', 'aria-label': 'Close', onclick: close }, UI.icon('x')));
    const foot = opts.buttons ? h('div.dlg-foot', opts.buttons.map((b) => h('button.btn' + (b.primary ? '.primary' : ''), { type: 'button', onclick: () => { if (b.onclick && b.onclick() === false) return; close(); } }, b.label))) : null;
    const box = h('div.dlg' + (opts.wide ? '.wide' : ''), { role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, head, h('div.dlg-body', body), foot);
    const back = h('div.dlg-back', { onmousedown: (e) => { if (e.target === back) close(); } }, box);
    document.body.appendChild(back);
    document.addEventListener('keydown', onKey, true);
    const f = box.querySelector('input, textarea, select, button.primary');
    if (f) setTimeout(() => f.focus(), 0);
    return { el: box, close };
  };
  UI.prompt = function (title, label, value, ok) {
    const input = h('input.inp', { type: 'text', value: value || '', 'aria-label': label });
    const d = UI.dialog(title, h('label.field', h('span', label), input), { buttons: [{ label: 'Cancel' }, { label: 'OK', primary: true, onclick: () => ok(input.value) }] });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(input.value); d.close(); } });
    setTimeout(() => { input.focus(); input.select(); }, 0);
    return d;
  };
  UI.confirm = function (title, text, ok, label) { return UI.dialog(title, h('p', text), { buttons: [{ label: 'Cancel' }, { label: label || 'OK', primary: true, onclick: ok }] }); };

  // ---- menus ----------------------------------------------------------------------------------------
  /** a pop-up menu at an element or point: items [{ label, icon, onclick, checked, disabled, sep, hint }] */
  UI.menu = function (anchor, items, opts) {
    UI.closeMenus();
    const m = h('div.menu', { role: 'menu' });
    for (const it of items) {
      if (it.sep) { m.appendChild(h('div.menu-sep')); continue; }
      if (it.head) { m.appendChild(h('div.menu-head', it.head)); continue; }
      const b = h('button.menu-item' + (it.checked ? '.on' : ''), { type: 'button', role: 'menuitem', disabled: it.disabled, onclick: () => { UI.closeMenus(); if (it.onclick) it.onclick(); } },
        h('span.mi-ic', it.checked ? UI.icon('check') : it.icon ? UI.icon(it.icon) : null), h('span.mi-l', it.label), it.hint ? h('span.mi-h', it.hint) : null);
      m.appendChild(b);
    }
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
    const mw = m.offsetWidth, mh = m.offsetHeight;
    let x = opts && opts.right ? r.right - mw : r.left, y = r.bottom + 4;
    if (x + mw > innerWidth - 8) x = innerWidth - mw - 8;
    if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 4);
    m.style.left = Math.max(8, x) + 'px'; m.style.top = y + 'px';
    setTimeout(() => document.addEventListener('mousedown', UI.closeOutside, true), 0);
    const first = m.querySelector('.menu-item'); if (first) first.focus();
    m.addEventListener('keydown', (e) => {
      const list = [...m.querySelectorAll('.menu-item:not([disabled])')];
      const i = list.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
      if (e.key === 'Escape') { e.preventDefault(); UI.closeMenus(); if (anchor.focus) anchor.focus(); }
    });
    return m;
  };
  UI.closeOutside = (e) => { if (!e.target.closest('.menu')) UI.closeMenus(); };
  UI.closeMenus = () => { document.querySelectorAll('.menu').forEach((m) => m.remove()); document.removeEventListener('mousedown', UI.closeOutside, true); };

  // ---- splitters --------------------------------------------------------------------------------------
  /** a drag handle that resizes the element before it (or after it with opts.after) */
  UI.splitter = function (dir, target, opts) {
    opts = opts || {};
    const bar = h('div.split.' + dir, { role: 'separator', 'aria-orientation': dir === 'v' ? 'vertical' : 'horizontal', tabindex: '0' });
    const key = opts.key;
    const saved = key ? UI.store.get(key) : null;
    if (saved) target.style[dir === 'v' ? 'width' : 'height'] = saved;
    const set = (px) => { const v = Math.max(opts.min || 120, Math.min(opts.max || 4000, px)) + 'px'; target.style[dir === 'v' ? 'width' : 'height'] = v; target.style.flex = 'none'; if (key) UI.store.set(key, v); if (opts.onresize) opts.onresize(); };
    bar.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      const start = dir === 'v' ? e.clientX : e.clientY;
      const size = dir === 'v' ? target.offsetWidth : target.offsetHeight;
      const sign = opts.after ? -1 : 1;
      document.body.classList.add('dragging');
      const move = (ev) => set(size + sign * ((dir === 'v' ? ev.clientX : ev.clientY) - start));
      const up = () => { bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); document.body.classList.remove('dragging'); };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
    });
    bar.addEventListener('keydown', (e) => {
      const d = (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -20 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 20 : 0) * (opts.after ? -1 : 1);
      if (d) { e.preventDefault(); set((dir === 'v' ? target.offsetWidth : target.offsetHeight) + d); }
    });
    return bar;
  };

  // ---- stored preferences (localStorage, which may be missing) ---------------------------------------
  UI.store = {
    get(k, d) { try { const v = localStorage.getItem('kwery.' + k); return v === null ? (d === undefined ? null : d) : JSON.parse(v); } catch (e) { return d === undefined ? null : d; } },
    set(k, v) { try { localStorage.setItem('kwery.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem('kwery.' + k); } catch (e) { /* private mode */ } },
  };

  // ---- values for display -------------------------------------------------------------------------------
  UI.valueText = function (v, t, zone) {
    if (v === null || v === undefined) return null;
    try { return K.T.output(v, t, { zone }); } catch (e) { return String(v); }
  };
  UI.esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  UI.plural = (n, w, ws) => n + ' ' + (n === 1 ? w : ws || w + 's');
  UI.ms = (x) => (x < 1 ? x.toFixed(2) : x < 10 ? x.toFixed(1) : Math.round(x).toLocaleString('en-US')) + ' ms';
  UI.debounce = (f, ms) => { let t = null; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; };
  UI.raf = (f) => { let pending = false; return () => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; f(); }); }; };
  UI.copy = (text) => { try { navigator.clipboard.writeText(text); UI.toast('Copied'); } catch (e) { UI.toast('Copy is not available here', 'err'); } };
  UI.download = (name, text, type) => { const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: type || 'text/plain' })), download: name }); document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); };
})(typeof window !== 'undefined' ? window : globalThis);
