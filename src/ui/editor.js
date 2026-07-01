// The SQL editor: a transparent textarea over a highlighted copy of the text, with line numbers, error marks
// under the token at fault, completion of names from the catalog, and the statement under the caret.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const { h } = UI;

  const KEYWORDS = new Set(('select from where group by having order limit offset fetch first next rows row only with ties distinct all as on using join inner left right full outer cross natural lateral ' +
    'union intersect except insert into values default update set delete returning create table view materialized index unique primary key foreign references ' +
    'check constraint not null drop alter add column rename to cascade restrict truncate begin commit rollback savepoint release transaction start isolation level ' +
    'read write committed uncommitted repeatable serializable grant revoke privileges public role user schema sequence type domain function procedure trigger returns ' +
    'language return declare if then else elsif end loop while for in exit continue case when and or is between like ilike similar escape exists any some ' +
    'asc desc nulls last recursive window over partition range groups preceding following current unbounded exclude others ties filter within ' +
    'explain analyze verbose vacuum checkpoint lock mode nowait skip locked share no action deferrable initially deferred immediate match simple partial ' +
    'generated always identity stored temporary temp if replace cast collate interval true false unknown array zone time at local cube rollup grouping sets ' +
    'conflict do nothing merge matched source target call execute prepare deallocate cursor close move copy stdin stdout csv header delimiter format ' +
    'enum assertion authorization option admin tablesample bernoulli system ordinality aggregate perform raise notice exception get diagnostics found strict ' +
    'before after instead each statement new old referencing of setof atomic immutable stable volatile called input security definer invoker show reset to concurrently refresh data').split(/\s+/));
  const TYPES = new Set('smallint integer int int2 int4 int8 bigint numeric decimal real float float4 float8 double precision boolean bool char character varchar varying text date time timestamp timestamptz interval bytea json jsonb uuid serial bigserial smallserial money record void trigger blob clob'.split(' '));
  // words that are keywords but name functions when a parenthesis follows
  const FUNCLIKE = new Set('left right replace format position trim substring extract coalesce nullif greatest least overlay filter row'.split(' '));
  K.SQL_KEYWORDS = KEYWORDS;
  K.SQL_TYPES = TYPES;

  /** tokens for highlighting; tolerant of unfinished text */
  function tokenize(src) {
    const out = [];
    const n = src.length;
    let i = 0;
    const push = (t, a, b) => out.push({ t, a, b });
    while (i < n) {
      const c = src[i];
      const start = i;
      if (c === '-' && src[i + 1] === '-') { while (i < n && src[i] !== '\n') i++; push('cm', start, i); continue; }
      if (c === '/' && src[i + 1] === '*') { let d = 1; i += 2; while (i < n && d) { if (src[i] === '/' && src[i + 1] === '*') { d++; i += 2; } else if (src[i] === '*' && src[i + 1] === '/') { d--; i += 2; } else i++; } push('cm', start, i); continue; }
      if (c === "'" || ((c === 'E' || c === 'e' || c === 'X' || c === 'x' || c === 'B' || c === 'b' || c === 'U' || c === 'u') && src[i + 1] === "'")) {
        i += c === "'" ? 1 : 2;
        const esc = c === 'E' || c === 'e';
        while (i < n) { if (esc && src[i] === '\\') { i += 2; continue; } if (src[i] === "'") { if (src[i + 1] === "'") { i += 2; continue; } i++; break; } i++; }
        push('str', start, i); continue;
      }
      if (c === '$') {
        const m = /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/.exec(src.slice(i, i + 64));
        if (m) { const tag = m[0]; const end = src.indexOf(tag, i + tag.length); i = end < 0 ? n : end + tag.length; push('str', start, i); continue; }
        if (/\d/.test(src[i + 1] || '')) { i++; while (i < n && /\d/.test(src[i])) i++; push('par', start, i); continue; }
      }
      if (c === '"') { i++; while (i < n) { if (src[i] === '"') { if (src[i + 1] === '"') { i += 2; continue; } i++; break; } i++; } push('qid', start, i); continue; }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) { while (i < n && /[0-9.]/.test(src[i])) i++; if (/[eE]/.test(src[i] || '') && /[-+0-9]/.test(src[i + 1] || '')) { i += 2; while (i < n && /[0-9]/.test(src[i])) i++; } push('num', start, i); continue; }
      if (/[A-Za-z_\u0080-￿]/.test(c)) {
        while (i < n && /[A-Za-z_0-9$\u0080-￿]/.test(src[i])) i++;
        const w = src.slice(start, i).toLowerCase();
        let j = i; while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
        push(KEYWORDS.has(w) && !(src[j] === '(' && FUNCLIKE.has(w)) ? 'kw' : TYPES.has(w) ? 'ty' : src[j] === '(' ? 'fn' : 'id', start, i);
        continue;
      }
      if (/\s/.test(c)) { while (i < n && /\s/.test(src[i])) i++; push('ws', start, i); continue; }
      i++;
      while (i < n && /[-+*/<>=~!@#%^&|`?:]/.test(src[i]) && /[-+*/<>=~!@#%^&|`?:]/.test(c)) i++;
      push(/[(),;[\].]/.test(c) ? 'pu' : 'op', start, i);
    }
    return out;
  }
  K.sqlTokens = tokenize;

  /** the statements of a script with their offsets (quotes, comments and dollar bodies respected) */
  function statements(src) {
    const toks = tokenize(src);
    const out = [];
    let s = null, depth = 0, begin = 0;
    for (const t of toks) {
      if (t.t === 'ws' || t.t === 'cm') continue;
      if (s === null) s = t.a;
      const w = t.t === 'kw' ? src.slice(t.a, t.b).toLowerCase() : '';
      // CREATE FUNCTION ... BEGIN ATOMIC ... END has semicolons inside
      if (w === 'atomic') begin++;
      if (w === 'end' && begin) begin--;
      if (t.t === 'pu' && src[t.a] === '(') depth++;
      if (t.t === 'pu' && src[t.a] === ')') depth = Math.max(0, depth - 1);
      if (t.t === 'pu' && src[t.a] === ';' && !depth && !begin) { out.push({ a: s, b: t.b, text: src.slice(s, t.b) }); s = null; }
    }
    if (s !== null) out.push({ a: s, b: src.length, text: src.slice(s) });
    return out;
  }
  K.sqlStatements = statements;

  class Editor {
    constructor(parent, opts) {
      this.opts = opts || {};
      this.handlers = {};
      this.gutter = h('div.ed-gutter', { 'aria-hidden': 'true' });
      this.hl = h('pre.ed-hl', { 'aria-hidden': 'true' });
      this.ta = h('textarea.ed-ta', { spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', wrap: 'off', 'aria-label': this.opts.label || 'SQL editor', 'data-gramm': 'false' });
      this.main = h('div.ed-main', this.hl, this.ta);
      this.root = h('div.ed', this.gutter, this.main);
      parent.appendChild(this.root);
      this.marks = [];
      this.pending = false;
      this.history = [];
      this.bind();
      this.setValue(this.opts.value || '');
    }
    on(ev, f) { (this.handlers[ev] = this.handlers[ev] || []).push(f); }
    emit(ev, d) { for (const f of this.handlers[ev] || []) f(d); }
    getValue() { return this.ta.value; }
    setValue(v) { this.ta.value = v; this.marks = []; this.render(); }
    focus() { this.ta.focus(); }
    /** mark a range (an error at a token, or the statement that ran) */
    mark(a, b, cls, title) { this.marks.push({ a, b: Math.max(b, a + 1), cls, title }); this.render(); }
    clearMarks(cls) { this.marks = cls ? this.marks.filter((m) => m.cls !== cls) : []; this.render(); }
    selection() { return { a: this.ta.selectionStart, b: this.ta.selectionEnd, text: this.ta.value.slice(this.ta.selectionStart, this.ta.selectionEnd) }; }
    /** the statement under the caret, or the selection */
    current() {
      const sel = this.selection();
      if (sel.b > sel.a) return { a: sel.a, b: sel.b, text: sel.text };
      const all = statements(this.ta.value);
      const at = sel.a;
      return all.find((s) => at >= s.a && at <= s.b) || all.filter((s) => s.b <= at).pop() || all[0] || null;
    }
    lineOf(pos) { const v = this.ta.value; let line = 0; for (let i = 0; i < pos && i < v.length; i++) if (v.charCodeAt(i) === 10) line++; return line; }
    scrollToPos(pos) {
      const line = this.lineOf(pos);
      const lh = this.lineHeight();
      const top = line * lh;
      if (top < this.ta.scrollTop || top > this.ta.scrollTop + this.ta.clientHeight - lh * 2) this.ta.scrollTop = Math.max(0, top - this.ta.clientHeight / 3);
    }
    lineHeight() { return parseFloat(getComputedStyle(this.ta).lineHeight) || 20; }
    insert(text) {
      const { a, b } = this.selection();
      this.ta.setRangeText(text, a, b, 'end');
      this.changed();
    }
    changed() { this.marks = this.marks.filter((m) => m.cls === 'ran' && false); this.schedule(); this.emit('change'); }
    schedule() { if (this.pending) return; this.pending = true; requestAnimationFrame(() => { this.pending = false; this.render(); }); }

    bind() {
      const ta = this.ta;
      ta.addEventListener('input', () => { this.changed(); this.maybeComplete(); });
      ta.addEventListener('scroll', () => { this.hl.scrollTop = ta.scrollTop; this.hl.scrollLeft = ta.scrollLeft; this.gutter.scrollTop = ta.scrollTop; this.hideCompletion(); });
      ta.addEventListener('keydown', (e) => this.onKey(e));
      ta.addEventListener('blur', () => setTimeout(() => this.hideCompletion(), 150));
      ta.addEventListener('click', () => { this.hideCompletion(); this.emit('caret'); });
      ta.addEventListener('keyup', (e) => { if (!['Shift', 'Control', 'Meta', 'Alt'].includes(e.key)) this.emit('caret'); });
    }
    onKey(e) {
      const ta = this.ta;
      const mod = e.ctrlKey || e.metaKey;
      if (this.comp && this.onCompletionKey(e)) return;
      if (mod && e.key === 'Enter') { e.preventDefault(); this.emit(e.shiftKey ? 'runAll' : 'run'); return; }
      if (e.key === 'F5') { e.preventDefault(); this.emit('runAll'); return; }
      if (mod && e.key === ' ') { e.preventDefault(); this.complete(true); return; }
      if (mod && e.key === '/') { e.preventDefault(); this.toggleComment(); return; }
      if (e.key === 'Tab' && !e.altKey) {
        e.preventDefault();
        const { a, b } = this.selection();
        const v = ta.value;
        if (b > a && v.slice(a, b).includes('\n')) {
          const s = v.lastIndexOf('\n', a - 1) + 1;
          const block = v.slice(s, b);
          const next = e.shiftKey ? block.replace(/^ {1,2}/gm, '') : block.replace(/^/gm, '  ');
          ta.setRangeText(next, s, b, 'select');
        } else if (!e.shiftKey) ta.setRangeText('  ', a, b, 'end');
        this.changed();
        return;
      }
      if (e.key === 'Enter' && !mod) {
        // keep the indentation of the line
        e.preventDefault();
        const { a, b } = this.selection();
        const v = ta.value;
        const s = v.lastIndexOf('\n', a - 1) + 1;
        const indent = /^[ \t]*/.exec(v.slice(s, a))[0];
        const extra = /\($/.test(v.slice(s, a).trimEnd()) ? '  ' : '';
        ta.setRangeText('\n' + indent + extra, a, b, 'end');
        this.changed();
        return;
      }
      const pairs = { '(': ')', "'": "'", '"': '"' };
      if (pairs[e.key] && !mod) {
        const { a, b } = this.selection();
        if (b > a) { e.preventDefault(); ta.setRangeText(e.key + ta.value.slice(a, b) + pairs[e.key], a, b, 'end'); this.changed(); return; }
      }
      if (e.key === ')' && ta.value[ta.selectionStart] === ')' && ta.selectionStart === ta.selectionEnd) { e.preventDefault(); ta.selectionStart = ta.selectionEnd = ta.selectionStart + 1; }
    }
    toggleComment() {
      const ta = this.ta, v = ta.value;
      const { a, b } = this.selection();
      const s = v.lastIndexOf('\n', a - 1) + 1;
      let e = v.indexOf('\n', Math.max(a, b - 1)); if (e < 0) e = v.length;
      const lines = v.slice(s, e).split('\n');
      const all = lines.every((l) => /^\s*--/.test(l) || !l.trim());
      const next = lines.map((l) => (all ? l.replace(/^(\s*)-- ?/, '$1') : l.trim() ? '-- ' + l : l)).join('\n');
      ta.setRangeText(next, s, e, 'select');
      this.changed();
    }

    // ---- completion -----------------------------------------------------------------------------
    wordBefore() {
      const v = this.ta.value, at = this.ta.selectionStart;
      let s = at;
      while (s > 0 && /[A-Za-z0-9_]/.test(v[s - 1])) s--;
      let qual = null;
      if (v[s - 1] === '.') { let q = s - 1; while (q > 0 && /[A-Za-z0-9_"]/.test(v[q - 1])) q--; qual = v.slice(q, s - 1).replace(/"/g, ''); }
      return { s, word: v.slice(s, at), qual };
    }
    maybeComplete() {
      const { word, qual } = this.wordBefore();
      if (qual !== null || word.length >= 2) this.complete(false); else this.hideCompletion();
    }
    complete(force) {
      if (!this.opts.complete) return;
      const w = this.wordBefore();
      const items = this.opts.complete(w.word, w.qual, this.ta.value, this.ta.selectionStart).slice(0, 40);
      if (!items.length || (!force && items.length === 1 && items[0].text.toLowerCase() === w.word.toLowerCase())) { this.hideCompletion(); return; }
      this.showCompletion(items, w);
    }
    showCompletion(items, w) {
      this.hideCompletion();
      const box = h('div.ed-comp', { role: 'listbox' });
      items.forEach((it, i) => box.appendChild(h('div.ed-ci' + (i === 0 ? '.on' : ''), { role: 'option', onmousedown: (e) => { e.preventDefault(); this.accept(i); } }, h('span.ci-k.' + it.kind, it.kind[0].toUpperCase()), h('span.ci-t', it.text), it.detail ? h('span.ci-d', it.detail) : null)));
      this.comp = { box, items, w, sel: 0 };
      // place it under the caret
      const pos = this.caretXY();
      box.style.left = pos.x + 'px'; box.style.top = pos.y + 'px';
      this.main.appendChild(box);
    }
    caretXY() {
      const v = this.ta.value, at = this.ta.selectionStart;
      const line = this.lineOf(at);
      const col = at - (v.lastIndexOf('\n', at - 1) + 1);
      const cw = this.charWidth || (this.charWidth = (() => { const m = h('span.ed-measure', 'MMMMMMMMMM'); this.main.appendChild(m); const w = m.getBoundingClientRect().width / 10; m.remove(); return w || 8; })());
      const pad = parseFloat(getComputedStyle(this.ta).paddingLeft) || 8;
      return { x: Math.min(pad + col * cw - this.ta.scrollLeft, this.main.clientWidth - 240), y: (line + 1) * this.lineHeight() + 6 - this.ta.scrollTop };
    }
    onCompletionKey(e) {
      const c = this.comp;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); c.sel = (c.sel + (e.key === 'ArrowDown' ? 1 : c.items.length - 1)) % c.items.length; [...c.box.children].forEach((x, i) => x.classList.toggle('on', i === c.sel)); c.box.children[c.sel].scrollIntoView({ block: 'nearest' }); return true; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); this.accept(c.sel); return true; }
      if (e.key === 'Escape') { e.preventDefault(); this.hideCompletion(); return true; }
      return false;
    }
    accept(i) {
      const c = this.comp;
      if (!c) return;
      const it = c.items[i];
      this.ta.setRangeText(it.insert || it.text, c.w.s, this.ta.selectionStart, 'end');
      this.hideCompletion();
      this.changed();
      this.ta.focus();
    }
    hideCompletion() { if (this.comp) { this.comp.box.remove(); this.comp = null; } }

    // ---- drawing --------------------------------------------------------------------------------
    render() {
      const v = this.ta.value;
      const toks = tokenize(v);
      // cut the token ranges where marks begin and end
      const cuts = new Set([0, v.length]);
      for (const m of this.marks) { cuts.add(Math.max(0, Math.min(v.length, m.a))); cuts.add(Math.max(0, Math.min(v.length, m.b))); }
      for (const t of toks) { cuts.add(t.a); cuts.add(t.b); }
      const points = [...cuts].sort((a, b) => a - b);
      let html = '';
      let ti = 0;
      for (let k = 0; k < points.length - 1; k++) {
        const a = points[k], b = points[k + 1];
        while (ti < toks.length && toks[ti].b <= a) ti++;
        const t = toks[ti] && toks[ti].a <= a ? toks[ti].t : 'ws';
        const ms = this.marks.filter((m) => m.a <= a && m.b >= b);
        const text = UI.esc(v.slice(a, b));
        const cls = (t !== 'ws' ? 't-' + t : '') + ms.map((m) => ' mk-' + m.cls).join('');
        html += cls.trim() ? '<span class="' + cls.trim() + '"' + (ms.length && ms[0].title ? ' title="' + UI.esc(ms[0].title) + '"' : '') + '>' + text + '</span>' : text;
      }
      this.hl.innerHTML = html + '\n';
      const lines = v.split('\n').length;
      if (this.gutter.childElementCount !== lines) {
        let g = '';
        for (let i = 1; i <= lines; i++) g += '<div>' + i + '</div>';
        this.gutter.innerHTML = g + '<div class="ed-pad"></div>';
      }
      this.hl.scrollTop = this.ta.scrollTop;
      this.gutter.scrollTop = this.ta.scrollTop;
    }
  }

  UI.Editor = Editor;
})(typeof window !== 'undefined' ? window : globalThis);
