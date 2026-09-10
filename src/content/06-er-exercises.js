// Chapter 6 design exercises: each problem statement of K.ER.exercises, answered by drawing a design in the E-R
// editor. The check compares the student's diagram with the reference design (K.ER.checkExercise), accepting
// the alternatives the chapter treats as equivalent and explaining every difference.
(function (root) {
  'use strict';
  const K = root.K;
  const C = K.Content;
  const ER = K.ER;
  if (!C || !ER || !ER.exercises) return;

  const LABEL = { error: 'Error.', warning: 'Warning.', info: 'Note.', ok: 'Accepted.' };
  // a third hint for every exercise: how to use the editor's own help before checking
  const GENERAL = 'Look at the Checks tab of the E-R editor before checking: the validator and the design checker catch missing keys, weak entity sets without owners and attributes that should be relationships.';

  function level(x) {
    const m = x.model();
    const size = m.entities.length + m.relationships.length;
    const hard = m.aggregations.length || m.specializations.length || m.relationships.some((r) => r.participants.length > 2);
    return hard || size > 10 ? 3 : size > 7 || m.entities.some((e) => e.weak) ? 2 : 1;
  }

  function check(x) {
    return function (app) {
      const ui = K.UI && K.UI.ER;
      const model = ui ? ui.answer(x.id) : null;
      if (!model || !model.entities.length) return { ok: false, message: 'Your diagram for this exercise is empty. Open the E-R editor, draw your design, and check again.' };
      const r = ER.checkExercise(x.id, model);
      const invalid = (r.problems || []).filter((p) => p.severity === 'error');
      const ok = r.correct && !invalid.length;
      const details = invalid.map((p) => '**Not valid yet.** ' + p.message)
        .concat(r.feedback.filter((f) => f.code !== 'match').sort((a, b) => ['error', 'warning', 'info', 'ok'].indexOf(a.level) - ['error', 'warning', 'info', 'ok'].indexOf(b.level)).map((f) => '**' + (LABEL[f.level] || 'Note.') + '** ' + f.message));
      const message = ok
        ? 'Your design matches the reference (score ' + r.score + ' of 100)' + (r.feedback.some((f) => f.level === 'ok' && f.code !== 'match') ? ', with the equivalent choices noted below.' : '.')
        : 'Score ' + r.score + ' of 100. ' + (invalid.length ? 'Fix the errors in the design first.' : 'The differences are below.');
      return { ok, message, details };
    };
  }

  for (const x of ER.exercises) {
    const hints = (x.hints || []).slice(0, 2);
    while (hints.length < 2) hints.push('Read the problem again sentence by sentence: each noun with properties of its own is a candidate entity set, each verb connecting them a candidate relationship set.');
    hints.push(GENERAL);
    C.exercise({
      id: 'er-' + x.id,
      chapter: 6,
      kind: 'er',
      db: null,
      title: x.title,
      level: level(x),
      text: [
        x.text,
        'Design an E-R diagram for it: the entity sets with their attributes and keys, the relationship sets with their mapping cardinalities and participation, and weak entity sets, specializations or aggregation where the problem calls for them.',
        { view: 'er', label: 'Draw it in the E-R editor', sel: { exercise: x.id } },
        { tip: 'Each exercise has a diagram of its own in the editor, kept in this browser. The check matches your entity sets by name or by their attributes, so your names need not be exactly those of the reference design.' },
      ],
      hints,
      ref: x.reference,
      check: check(x),
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
