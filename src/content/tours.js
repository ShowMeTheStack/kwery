// Guided tours: a callout next to a part of the workbench, step by step.
(function (root) {
  'use strict';
  const C = root.K.Content;
  C.tour({
    id: 'tour-first', title: 'A first look around',
    steps: [
      { target: '.ed-box', text: 'This is the SQL editor. The Theatre sample is loaded: theatre companies and their productions, venues and stages, artists and their roles, performances, patrons and their bookings. Type a query here.' },
      { target: '.top-run .btn.primary', text: 'Run sends the statement under the caret to the database (`Ctrl` + `Enter`). **Run all** runs the whole script (`Ctrl` + `Shift` + `Enter`).', before: (app) => { if (!app.editor.getValue().trim()) app.editor.setValue('select title, genre from production order by title;\n'); } },
      { target: '.results', text: 'The results of each statement appear here: rows with the column types in the header, and the command tag (SELECT 18, INSERT 0 1 ...). Errors point at the token at fault.', before: (app) => app.run('all') },
      { target: '.dock', text: 'The dock on the right shows the database working. The **Plan** view is the tree of operators that ran your query, with the rows each produced.', before: (app) => app.openView('plan') },
      { target: '.stepbar', text: 'Every run is recorded. Step backwards and forwards through what the engine did: each operator call, each row, each page read, each log record.' },
      { target: '.top .btn.ghost', text: '**Views** opens the others: the pages of a table, the buffer pool, B+ trees and hash indexes, locks and versions, the log and recovery, the E-R canvas, the algebra and design workbenches, and a simulated cluster.' },
      { target: '.tab-add', text: 'Each tab is its own **session**, as if a second person were connected. Two tabs can run transactions that get in each other\'s way, and you can watch who waits for whom.' },
      { target: '.rail', text: 'On the left: the **schema** of the database, the **lessons** chapter by chapter, **exercises** that check your answers, the **reference**, and your **history**.' },
      { target: '.status', text: 'The status bar shows the active session, whether a transaction is open, and the simulated disk and buffer pool counters.' },
    ],
  });
})(typeof window !== 'undefined' ? window : globalThis);
