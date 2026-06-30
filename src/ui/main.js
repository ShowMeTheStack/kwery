// Start the workbench once the page is ready (and the saved database, if any, has been read).
(function (root) {
  'use strict';
  const K = root.K;
  const start = async () => {
    try { await K.UI.Persist.init(); } catch (e) { /* start fresh */ }
    K.app = new K.UI.App(document.getElementById('app'));
    if (K.UI.Share) K.UI.Share.open(K.app);
    K.app.on('run', (run) => { if (run.results.some((r) => r.tag && !/^(SELECT|SHOW|EXPLAIN|FETCH)/.test(r.tag))) K.UI.Persist.save(K.app); });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})(typeof window !== 'undefined' ? window : globalThis);
