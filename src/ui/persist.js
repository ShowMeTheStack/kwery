// Keeping the database between visits: after changes, a snapshot goes into the browser's IndexedDB (when there
// is one); the next visit opens it instead of the fresh sample.
(function (root) {
  'use strict';
  const K = root.K;
  const UI = K.UI;
  const NAME = 'kwery', STORE = 'dbs';
  const open = () => new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no IndexedDB')); return; }
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const req = (mode, f) => open().then((db) => new Promise((resolve, reject) => { const tx = db.transaction(STORE, mode); const r = f(tx.objectStore(STORE)); tx.oncomplete = () => resolve(r && r.result); tx.onerror = () => reject(tx.error); }));
  const key = () => 'db:' + ((UI.store.get('settings', {}) || {}).sample || 'theatre');

  const Persist = UI.Persist = {
    loaded: null,
    enabled: UI.store.get('persist', true),
    /** read the saved database (before the app starts) */
    async init() {
      if (!this.enabled) return;
      try { this.loaded = (await req('readonly', (s) => s.get(key()))) || null; } catch (e) { this.loaded = null; }
    },
    save(app) {
      if (!this.enabled) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        // a database in the middle of a transaction is saved later, once nothing is open
        if (app.db.sessions.some((s) => s.tx)) return;
        let snap;
        try { snap = K.Snapshot.save(app.db); } catch (e) { console.error(e); return; }
        req('readwrite', (s) => s.put(snap, key())).catch(() => {});
      }, 1500);
    },
    clear() { clearTimeout(this.timer); this.loaded = null; return req('readwrite', (s) => s.delete(key())).catch(() => {}); },
  };
  void Persist;
})(typeof window !== 'undefined' ? window : globalThis);
