// Chapter 17: transactions. ACID, transaction states, schedules and serializability, recoverability, isolation
// levels and transactions in SQL. This file also defines the small kit the content of chapters 17 to 26 shares
// (K.Content.kit1726): predictions with their answers shuffled, and checks for exercises answered in words.
(function (root) {
  'use strict';
  const K = root.K;
  const C = K.Content;

  // ---- the kit ------------------------------------------------------------------------------------------------------
  const kit = C.kit1726 = C.kit1726 || (function () {
    // the right answer of a prediction may be written anywhere; rotate the options by a hash of the question
    const mix = (l) => {
      for (const b of l.body || []) {
        if (!b || !b.predict) continue;
        const p = b.predict, n = p.options.length;
        let k = 0;
        for (const ch of p.q) k = (k * 31 + ch.charCodeAt(0)) >>> 0;
        k %= n;
        const right = p.options[p.answer];
        p.options = p.options.slice(k).concat(p.options.slice(0, k));
        p.answer = p.options.indexOf(right);
      }
      return l;
    };
    const lesson = (l) => C.lesson(mix(l));
    /** the answer as typed: comments dropped, lower case, spaces squeezed */
    const norm = (a) => String(a || '').replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').toLowerCase().replace(/\s+/g, ' ').trim();
    const looksLikeSql = (t) => /^(select|insert|update|delete|with|create|begin|set)\b/.test(t);
    /** transactions named in the answer: T1, t2, T 3 -> ['1', '2', '3'] in order */
    const txs = (t) => [...t.matchAll(/\bt\s*(\d+)\b/g)].map((m) => m[1]);
    const none = (t) => /\b(none|nothing|no one|nobody|empty|neither)\b/.test(t);
    /** yes or no: the first such word in the answer, or null */
    const yesNo = (t) => { const m = /\b(yes|no|true|false|y|n)\b/.exec(t); return m ? ['yes', 'true', 'y'].includes(m[1]) : null; };
    const yesNos = (t) => [...t.matchAll(/\b(yes|no|true|false)\b/g)].map((m) => m[1] === 'yes' || m[1] === 'true');
    const nums = (t) => [...t.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
    const T = (list) => list.map((x) => 'T' + x).join(', ');
    const ok = (message) => ({ ok: true, message: message || 'That is right.' });
    const no = (message) => ({ ok: false, message });
    const empty = (t) => (!t ? no('The editor is empty: type your answer there, then check it.') : null);
    const S = () => K.Schedule;

    /** "yes, T2 T1 T3" or "no": is the schedule conflict serializable, and in which serial order? */
    function serial(schedule) {
      return (app, answer) => {
        const t = norm(answer);
        if (empty(t)) return empty(t);
        const r = S().conflictSerializable(schedule);
        const yn = yesNo(t);
        if (yn === null) return no('Start with yes or no.');
        if (!r.serializable) return yn ? no('It is not conflict serializable: look for a cycle in the precedence graph.') : ok('Right: ' + r.explanation);
        if (!yn) return no('It is conflict serializable: draw the precedence graph again and look for a cycle. Is there one?');
        const order = txs(t);
        const g = r.graph;
        if (!order.length) return no('Yes is right; now give an equivalent serial order, such as T1 T2 T3.');
        if (order.length !== g.nodes.length || !g.nodes.every((x) => order.includes(x))) return no('The serial order must name each of ' + T(g.nodes) + ' once.');
        const broken = g.edges.find((e) => order.indexOf(e.from) > order.indexOf(e.to));
        if (broken) return no('In your order T' + broken.to + ' comes before T' + broken.from + ', but ' + broken.reasons[0].first + ' comes before ' + broken.reasons[0].second + ' in the schedule.');
        return ok('Right: ' + r.explanation);
      };
    }
    /** "yes no no": is the schedule recoverable, cascadeless, strict (or the properties named), in that order */
    function props(schedule, which) {
      which = which || ['recoverable', 'cascadeless', 'strict'];
      return (app, answer) => {
        const t = norm(answer);
        if (empty(t)) return empty(t);
        const got = yesNos(t);
        if (got.length !== which.length) return no('Answer yes or no for each of: ' + which.join(', ') + ' (' + which.length + ' words, in that order).');
        const right = which.map((w) => {
          if (w === 'recoverable') return S().recoverable(schedule).recoverable;
          if (w === 'cascadeless') return S().cascadeless(schedule).cascadeless;
          if (w === 'strict') return S().strict(schedule).strict;
          if (w === 'conflict') return S().conflictSerializable(schedule).serializable;
          if (w === 'view') return S().viewSerializable(schedule).serializable;
          if (w === 'serial') return S().isSerial(schedule);
          throw new Error('unknown property ' + w);
        });
        const wrong = which.filter((w, i) => got[i] !== right[i]);
        if (wrong.length) return no('Not yet: ' + (wrong.length === 1 ? 'one answer is' : wrong.length + ' answers are') + ' wrong. Check ' + (wrong.length === 1 ? 'the one about ' + wrong[0] : 'them') + ' again.');
        return ok('Right: ' + which.map((w, i) => w + ' ' + (right[i] ? 'yes' : 'no')).join(', ') + '.');
      };
    }
    /** which transactions does a protocol roll back on this schedule? "T2", "T1 T3" or "none" */
    function aborted(schedule, protocol, opts) {
      return (app, answer) => {
        const t = norm(answer);
        if (empty(t)) return empty(t);
        const run = S().simulate(schedule, protocol, opts || {});
        const right = [...new Set(run.aborts.map((a) => a.tx))].sort();
        return sameSet(t, right, 'rolled back');
      };
    }
    /** compare the transactions named in the answer with a set */
    function sameSet(t, right, what) {
      const got = [...new Set(txs(t))].sort();
      if (!got.length && !none(t)) return no('Name the transactions as T1, T2, ... (or write none).');
      if (none(t) && got.length) return no('Either name transactions or write none, not both.');
      if (JSON.stringify(got) === JSON.stringify(right)) return ok(right.length ? 'Right: ' + T(right) + '.' : 'Right: none.');
      const extra = got.filter((x) => !right.includes(x)), missing = right.filter((x) => !got.includes(x));
      return no(!right.length ? 'No transaction is ' + what + ' here.' : (extra.length ? T(extra) + ' should not be in your answer. ' : '') + (missing.length ? 'Some ' + what + ' transaction is missing.' : ''));
    }
    /** an answer that is a set of transactions known in advance */
    const txSet = (right, what) => (app, answer) => { const t = norm(answer); return empty(t) || sameSet(t, right.map(String).map((x) => x.replace(/^T/i, '')).sort(), what || 'meant'); };
    /** an ordered list of transactions */
    const txList = (right) => (app, answer) => {
      const t = norm(answer);
      if (empty(t)) return empty(t);
      const got = txs(t), want = right.map((x) => String(x).replace(/^T/i, ''));
      if (!got.length) return no('Name the transactions as T1, T2, ... in order.');
      return JSON.stringify(got) === JSON.stringify(want) ? ok('Right: ' + T(want) + '.') : no('Not that order. Work through it again, one step at a time.');
    };
    /** a set of numbers (LSNs, pages, nodes); order does not matter unless ordered is set */
    const numSet = (right, opts) => (app, answer) => {
      opts = opts || {};
      const t = norm(answer);
      if (empty(t)) return empty(t);
      if (looksLikeSql(t)) return no('Answer with the numbers themselves, not a query.');
      let got = nums(t);
      if (!got.length && none(t)) got = [];
      else if (!got.length) return no('Write the numbers, separated by spaces or commas (or none).');
      const a = opts.ordered ? got : [...new Set(got)].sort((x, y) => x - y), b = opts.ordered ? right : [...new Set(right)].sort((x, y) => x - y);
      return JSON.stringify(a) === JSON.stringify(b) ? ok('Right: ' + (b.length ? b.join(', ') : 'none') + '.') : no(a.length !== b.length ? 'Your answer has ' + a.length + ' numbers; the answer has ' + b.length + '.' : 'Some numbers are not right.');
    };
    /** one number, within a tolerance */
    const number = (right, tol) => (app, answer) => {
      const t = norm(answer);
      if (empty(t)) return empty(t);
      if (looksLikeSql(t)) return no('Answer with the number itself, not a query.');
      const got = nums(t);
      if (got.length !== 1) return no('Write one number.');
      return Math.abs(got[0] - right) <= (tol || 0) ? ok('Right: ' + right + '.') : no('Not ' + got[0] + '. Work it through again.');
    };
    /** one of a few words or letters: choice(['b']) or choice(['abort', 'aborts']) */
    const choice = (rights, all) => (app, answer) => {
      const t = norm(answer);
      if (empty(t)) return empty(t);
      // hyphens do not matter: non-repeatable, nonrepeatable; wound-wait, woundwait
      const flat = (x) => String(x).replace(/-/g, '');
      const words = t.split(/[^a-z0-9-]+/).filter(Boolean).map(flat);
      const hit = rights.find((r) => words.includes(flat(r)));
      const others = (all || []).filter((x) => !rights.includes(x) && words.includes(flat(x)));
      if (hit && !others.length) return ok();
      if (hit && others.length) return no('Give one answer, not several.');
      return no(all ? 'Answer with one of: ' + all.join(', ') + '.' : 'Not that one.');
    };
    /** several yes/no answers in a given order */
    const yesNoList = (right, labels) => (app, answer) => {
      const t = norm(answer);
      if (empty(t)) return empty(t);
      const got = yesNos(t);
      if (got.length !== right.length) return no('Answer yes or no ' + right.length + ' times' + (labels ? ' (' + labels.join(', ') + ')' : '') + '.');
      const wrong = right.map((r, i) => (got[i] !== r ? i : -1)).filter((i) => i >= 0);
      return wrong.length ? no('Not yet: ' + (wrong.length === 1 ? 'one answer is wrong' + (labels ? ' (' + labels[wrong[0]] + ')' : '') : wrong.length + ' answers are wrong') + '.') : ok();
    };
    return { mix, lesson, norm, txs, yesNo, yesNos, nums, ok, no, serial, props, aborted, sameSet, txSet, txList, numSet, number, choice, yesNoList };
  })();
  const lesson = kit.lesson;

  // ---- lessons ------------------------------------------------------------------------------------------------------

  const ACCT = "drop table if exists acct;\ncreate table acct (\n  id int primary key,\n  owner text,\n  bal int check (bal between 0 and 1000)\n);\ninsert into acct values (1, 'Ana', 500), (2, 'Ben', 950);";

  lesson({
    id: 'tx-acid', chapter: 17, title: 'Transactions and the ACID properties', minutes: 14,
    summary: 'A transaction is a unit of work the database treats as one. Break each of its four promises on purpose and watch what goes wrong.',
    body: [
      'A **transaction** is a sequence of reads and writes that the database treats as a single unit. Take a credit union moving 100 from one member\'s account to another\'s: subtract 100 here, add 100 there. Either both changes happen or neither does, and nobody should ever see the money in flight.',
      'Make two small accounts. Each balance must stay between 0 and 1000, a rule the table enforces with a check constraint.',
      { sql: ACCT + "\nselect * from acct order by id;" },
      'The database promises four things about a transaction, known by their initials as **ACID**.',
      { def: 'Atomicity.', text: 'All of the transaction\'s changes take effect, or none do.' },
      { def: 'Consistency.', text: 'A transaction that runs alone, from a consistent state, leaves a consistent state.' },
      { def: 'Isolation.', text: 'Transactions running at the same time do not see each other\'s unfinished work; the result is as if they ran one after another.' },
      { def: 'Durability.', text: 'Once a transaction has committed, its changes survive any later failure.' },
      { h: 'Atomicity, broken on purpose' },
      'Move 100 from Ana to Ben as two separate statements. With no `begin`, each statement is a transaction of its own (autocommit). Ben has 950, so the credit breaks the upper limit and fails. The debit has already been committed.',
      { sql: "update acct set bal = bal - 100 where id = 1;\nupdate acct set bal = bal + 100 where id = 2;", fails: '23514', note: 'The second statement fails with a check violation.' },
      { sql: 'select owner, bal, (select sum(bal) from acct) as total\nfrom acct order by id;', note: 'The total was 1450. Now 100 has simply vanished.' },
      'Put the money back and try again, this time as one transaction.',
      { sql: "update acct set bal = 500 where id = 1;\nbegin;\nupdate acct set bal = bal - 100 where id = 1;\nupdate acct set bal = bal + 100 where id = 2;", fails: '23514' },
      { predict: { q: 'The credit failed inside the transaction. What happens if you now type `commit`?', options: ['The transaction is rolled back: Ana is back at 500', 'The debit is committed and Ana has 400', 'An error, and the transaction stays open'], answer: 0, explain: 'After an error the transaction can only end one way. PostgreSQL, and Kwery, answer COMMIT with ROLLBACK: nothing of it is kept. That is atomicity: the debit disappears with the failed credit.' }, sql: 'commit;\nselect owner, bal from acct order by id;' },
      { h: 'Consistency' },
      'The database checks the rules it was told about, such as the check constraint. Other rules live only in the application. Here, a transfer must not change the total. A transaction that debits one account and forgets the credit is perfectly atomic and still wrong. Consistency is a shared job: the database enforces declared constraints, and the programmer writes transactions that keep the rest.',
      { h: 'Isolation, seen from a second tab' },
      'Open a second editor tab with the **+** next to the editor tab. Each tab is its own session. In tab 1, start a transfer and stop halfway:',
      { sql: "begin;\nupdate acct set bal = bal - 100 where id = 1;", note: 'In tab 1. The transaction stays open.' },
      { sql: 'select sum(bal) as total from acct;', tab: 2, note: 'In tab 2. Still 1450: tab 2 does not see the unfinished debit.' },
      { sql: 'rollback;', note: 'In tab 1.' },
      'Run as two autocommit statements, as in the first attempt, the transfer would have shown tab 2 a total of 1350 between the two steps. Isolation is what hides that intermediate state.',
      { h: 'Durability' },
      'A commit is a promise. Kwery keeps it the way real systems do: the commit record is written to the log on stable storage before COMMIT returns. The **Crash and recovery** view lets you pull the plug. Its scenario *Commit without waiting for the log* breaks durability on purpose: with `synchronous_commit` off, COMMIT returns before the log is flushed, and a crash at the wrong moment loses a committed transaction.',
      { view: 'recovery', label: 'Open the crash and recovery view' },
      { sql: 'drop table acct;' },
      { tip: 'Atomicity and durability are the job of the recovery system (chapter 19). Isolation is the job of concurrency control (chapter 18). Consistency rests on both, plus correct transactions.' },
    ],
  });

  const STATES_SVG = '<svg viewBox="0 0 520 190" width="520" role="img" aria-label="Transaction states: active, partially committed, committed, failed, aborted" style="max-width:100%;font:13px system-ui,sans-serif">'
    + '<defs><marker id="k17a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>'
    + '<g fill="none" stroke="currentColor" stroke-width="1.4">'
    + '<rect x="10" y="75" width="90" height="36" rx="18"/><rect x="170" y="15" width="150" height="36" rx="18"/><rect x="400" y="15" width="110" height="36" rx="18"/>'
    + '<rect x="190" y="135" width="110" height="36" rx="18"/><rect x="400" y="135" width="110" height="36" rx="18"/>'
    + '<path d="M80 75 L170 40" marker-end="url(#k17a)"/><path d="M80 111 L190 150" marker-end="url(#k17a)"/><path d="M320 33 L400 33" marker-end="url(#k17a)"/>'
    + '<path d="M245 51 L245 135" marker-end="url(#k17a)"/><path d="M300 153 L400 153" marker-end="url(#k17a)"/></g>'
    + '<g fill="currentColor" text-anchor="middle"><text x="55" y="98">active</text><text x="245" y="38">partially committed</text><text x="455" y="38">committed</text><text x="245" y="158">failed</text><text x="455" y="158">aborted</text></g></svg>';

  lesson({
    id: 'tx-states', chapter: 17, title: 'The states of a transaction', minutes: 8,
    summary: 'Active, partially committed, committed, failed and aborted: the life of a transaction, and how to see which state yours is in.',
    body: [
      'A transaction moves through a small number of states. It begins **active**. When its last statement has run it is **partially committed**: its work is done, but it may still fail before the commit record is safely in the log. Once it is, the transaction is **committed**. If anything goes wrong first, it is **failed**, and after its changes have been undone it is **aborted**.',
      { svg: STATES_SVG, caption: 'A transaction that has committed or aborted is said to have **terminated**.' },
      'Make a small table, start a transaction, and ask the database what state the session is in. `pg_stat_activity` has a row per session:',
      { sql: "drop table if exists seats;\ncreate table seats (perf text primary key, free int check (free >= 0));\ninsert into seats values ('Fri 19:30', 2), ('Sat 14:00', 0);\nbegin;\nupdate seats set free = free - 1 where perf = 'Fri 19:30';\nselect state from pg_stat_activity where pid = pg_backend_pid();" },
      '*idle in transaction* means the transaction is active and waiting for its next statement. Now make it fail: the Saturday matinee is sold out.',
      { sql: "update seats set free = free - 1 where perf = 'Sat 14:00';", fails: '23514' },
      { predict: { q: 'The transaction is now failed. What does the next statement, even a harmless `select 1`, do?', options: ['It is refused: the transaction can only be rolled back', 'It runs normally', 'It starts a new transaction by itself'], answer: 0, explain: 'A failed transaction accepts no more work. Every statement is refused with "current transaction is aborted" until you end it.' }, sql: 'select 1;', fails: '25P02' },
      { sql: 'select pid, state from pg_stat_activity order by pid;', tab: 2, note: 'In tab 2 (open it with + next to the editor tab): tab 1\'s session is *idle in transaction (aborted)*, the failed state.' },
      'Rolling back moves the transaction from failed to aborted. Its first update, the Friday seat, is undone with it.',
      { sql: "rollback;\nselect * from seats order by perf;" },
      { h: 'After an abort' },
      'Once a transaction has aborted, the system has two choices. It can **restart** it, as a new transaction, when the failure had nothing to do with its own logic (a deadlock, a crash). Or it can **kill** it, when the failure was the transaction\'s own fault, such as bad input. A sold-out performance is not going to free a seat by itself: retrying our booking would fail again, so the application should report it instead.',
      { tip: 'A transaction that writes to the outside world, say prints a ticket, cannot take that back on abort. Systems hold such **observable external writes** until the transaction has committed.' },
      { sql: 'drop table seats;' },
    ],
  });

  lesson({
    id: 'tx-serializability', chapter: 17, title: 'Schedules and serializability', minutes: 15,
    summary: 'A schedule is an interleaving of transactions. When is one as good as running them one at a time? Conflicts, the precedence graph, and view serializability.',
    body: [
      'When transactions run concurrently, their operations interleave. The order in which they actually happen is a **schedule**. A **serial** schedule runs one transaction completely, then the next. Serial schedules are always correct, assuming each transaction is correct alone. Concurrency is worth having only if we can tell which other schedules are just as good.',
      'We write a schedule compactly: `r1(A)` is a read of item A by T1, `w2(B)` a write of B by T2, `c1` the commit of T1.',
      { h: 'Conflicting operations' },
      'Two operations **conflict** when they belong to different transactions, touch the same item, and at least one of them is a write. Swapping two adjacent operations that do not conflict cannot change anything any transaction sees or writes. Swapping two that conflict can.',
      { table: [['Pair on the same item', 'Conflict?', 'Why'], ['read, read', 'no', 'both see the same value in either order'], ['read, write', 'yes', 'the read sees the old or the new value'], ['write, read', 'yes', 'the same, the other way round'], ['write, write', 'yes', 'the final value depends on which write is last']] },
      'A schedule is **conflict serializable** if swapping adjacent non-conflicting operations can turn it into a serial schedule. The test is a graph. Draw a node per transaction, and an edge Ti → Tj whenever an operation of Ti conflicts with a later operation of Tj. This is the **precedence graph**. The schedule is conflict serializable exactly when the graph has no cycle, and any topological order of the graph is an equivalent serial order.',
      { view: 'schedule', sel: { schedule: 'r2(X) r1(Y) w2(X) r1(X) w1(Y) r3(Y) w3(Z) c1 c2 c3' }, label: 'Open this schedule in the Schedules view' },
      { predict: { q: 'In `r2(X) r1(Y) w2(X) r1(X) w1(Y) r3(Y) w3(Z)`, which edges does the precedence graph have?', options: ['T2 → T1 (on X) and T1 → T3 (on Y)', 'T1 → T2 and T2 → T3', 'T2 → T1 and T1 → T2: a cycle'], answer: 0, explain: '`w2(X)` comes before `r1(X)`: T2 → T1. `w1(Y)` comes before `r3(Y)`: T1 → T3. `r1(Y)` and `r3(Y)` are both reads and do not conflict. No cycle, so the serial order T2, T1, T3 is equivalent.' } },
      { h: 'A real interleaving' },
      'Schedules are not only on paper. Keep the Schedules view open, open a second editor tab (**+**), and run these blocks in the order shown. Two transactions each move a little stock between two shelves.',
      { sql: "drop table if exists shelf;\ncreate table shelf (item text primary key, qty int);\ninsert into shelf values ('A', 10), ('B', 10);", note: 'In tab 1.' },
      { sql: "begin;\nselect qty from shelf where item = 'A';\nupdate shelf set qty = qty - 1 where item = 'A';", note: 'In tab 1: T1 reads and writes A.' },
      { sql: "begin;\nselect qty from shelf where item = 'B';\nupdate shelf set qty = qty - 2 where item = 'B';", tab: 2, note: 'In tab 2: T2 reads and writes B.' },
      { sql: "update shelf set qty = qty + 1 where item = 'B';", tab: 2, note: 'In tab 2: T2 writes B again.' },
      { sql: 'commit;', tab: 2, note: 'In tab 2.' },
      { sql: "select qty from shelf where item = 'B';\nupdate shelf set qty = qty + 2 where item = 'B';\ncommit;", note: 'In tab 1: T1 now reads and writes B, after T2 committed.' },
      'In the Schedules view, press **Replay the real history**. The view turns what ran into a schedule and draws its precedence graph. T2 wrote B before T1 read it, so the only edge is T2 → T1, and the interleaving is equivalent to running T2 first.',
      { sql: 'select * from shelf order by item;\ndrop table shelf;' },
      { h: 'View serializability, briefly' },
      'Conflict serializability is sufficient but stricter than needed. **View serializability** asks only that each read sees the same write as in some serial schedule, and that each item has the same final writer. Every conflict serializable schedule is view serializable. The converse fails only through **blind writes**, writes of an item the transaction never read:',
      { view: 'schedule', sel: { schedule: 'w1(A) w2(A) w2(B) w1(B) w3(A) w3(B) c1 c2 c3' }, label: 'Open a view serializable schedule with blind writes' },
      'Nobody reads anything here. On A, T1 writes before T2 (T1 → T2); on B, T2 writes before T1 (T2 → T1): a cycle, so the schedule is not conflict serializable. Yet T3 writes both items last, so in the serial order T1, T2, T3 every item has the same final writer, and there are no reads to disagree. Whatever T1 and T2 wrote is overwritten before anyone reads it. Testing view serializability is NP-complete, so real systems aim for conflict serializability.',
    ],
  });

  lesson({
    id: 'tx-recoverable', chapter: 17, title: 'Recoverable and cascadeless schedules', minutes: 10,
    summary: 'Serializable is not enough when transactions can abort. A schedule must also let the system undo a failed transaction cleanly.',
    body: [
      'So far every transaction committed. Suppose T1 writes A, T2 reads that value and commits, and then T1 aborts. T2 has committed a decision based on a value that never existed, and committed work cannot be undone. That schedule is **not recoverable**.',
      { def: 'Recoverable.', text: 'Whenever Tj reads an item last written by Ti, Ti commits before Tj commits.' },
      { def: 'Cascadeless.', text: 'Whenever Tj reads an item last written by Ti, Ti has already committed when Tj reads it. Transactions read only committed data.' },
      { def: 'Strict.', text: 'No transaction reads or overwrites an item until the last transaction that wrote it has committed or aborted.' },
      'Each property implies the one above it. A recoverable schedule can still suffer a **cascading rollback**: if T2 read from an uncommitted T1, and T3 from T2, an abort of T1 drags both down with it. Cascadeless schedules avoid that work.',
      { view: 'schedule', sel: { schedule: 'w1(A) r2(A) w2(B) r3(B) a1 c2 c3' }, label: 'Open a schedule with a cascading rollback' },
      { predict: { q: 'Is `w1(A) r2(A) c1 w2(B) c2` recoverable? Cascadeless?', options: ['Recoverable, not cascadeless', 'Both', 'Neither', 'Cascadeless, not recoverable'], answer: 0, explain: 'T2 reads A from T1, and T1 commits before T2: recoverable. But T2 reads A while T1 is still running, so an abort of T1 would force T2 to abort too: not cascadeless.' } },
      { h: 'A cascading rollback, live' },
      'PostgreSQL, and Kwery\'s default, never let a transaction read uncommitted data, so you cannot get a cascade there. Basic two-phase locking (chapter 18) can. Switch the protocol for a moment:',
      { sql: "drop table if exists acct;\ncreate table acct (id int primary key, bal int);\ninsert into acct values (1, 100), (2, 200);\nset concurrency_control = '2pl';", note: 'In tab 1. The protocol applies to every session.' },
      { sql: "begin;\nupdate acct set bal = 5 where id = 1;\nselect lock_point();", note: 'In tab 1: T1 writes 5, then declares its lock point. Basic 2PL may now release its locks, the exclusive one included.' },
      { sql: 'begin;\nselect bal from acct where id = 1;', tab: 2, note: 'In tab 2 (open it with +): T2 reads the uncommitted 5.' },
      { sql: 'rollback;', note: 'In tab 1: T1 aborts.' },
      { sql: 'select bal from acct where id = 1;', tab: 2, fails: '25P02', note: 'In tab 2: T2 was rolled back with T1, a cascading rollback.' },
      { sql: 'rollback;', tab: 2, note: 'In tab 2.' },
      { sql: "set concurrency_control = 'mvcc';\ndrop table acct;", note: 'In tab 1: back to the default.' },
      'The transactions view has this as the scenario *Cascading rollback*. Run it under basic 2PL, then strict 2PL: strict 2PL keeps exclusive locks to the end, which makes every schedule it allows strict, and so cascadeless.',
      { view: 'txn', sel: { scenario: 'cascade' }, label: 'Run the cascading rollback scenario' },
    ],
  });

  lesson({
    id: 'tx-isolation', chapter: 17, title: 'Isolation levels and their anomalies', minutes: 15,
    summary: 'Weaker isolation buys concurrency and lets certain anomalies through. Make each one happen in two tabs, and see which level stops it.',
    body: [
      'Serializability is the gold standard, but it costs waiting and retries. SQL lets a transaction ask for less, in exchange for more concurrency. The standard defines four **isolation levels** by the anomalies each must prevent.',
      { table: [['Level', 'Dirty read', 'Non-repeatable read', 'Phantom'], ['Read uncommitted', 'allowed', 'allowed', 'allowed'], ['Read committed', 'prevented', 'allowed', 'allowed'], ['Repeatable read', 'prevented', 'prevented', 'allowed'], ['Serializable', 'prevented', 'prevented', 'prevented']] },
      'The standard sets minimums. PostgreSQL, whose behavior Kwery follows, is stricter: read uncommitted behaves as read committed, and repeatable read also rules out phantoms, because both are built on snapshots (chapter 18). Read committed is the default.',
      { sql: "drop table if exists acct;\ncreate table acct (id int primary key, bal int);\ninsert into acct values (1, 100), (2, 200);\nshow default_transaction_isolation;", note: 'In tab 1. Open a second tab with + for the steps marked tab 2.' },
      { h: 'Dirty read: never' },
      { sql: 'begin;\nupdate acct set bal = 0 where id = 1;', tab: 2, note: 'In tab 2: an uncommitted write.' },
      { sql: 'begin isolation level read uncommitted;\nselect bal from acct where id = 1;\ncommit;', note: 'In tab 1. Even at the lowest level, 100: the uncommitted 0 is invisible.' },
      { sql: 'rollback;', tab: 2, note: 'In tab 2.' },
      { h: 'Non-repeatable read: under read committed' },
      { sql: 'begin;\nselect bal from acct where id = 1;', note: 'In tab 1: T1 reads 100.' },
      { sql: 'update acct set bal = 50 where id = 1;', tab: 2, note: 'In tab 2: committed at once (autocommit).' },
      { predict: { q: 'T1 is at read committed. What does its second read of the same row return?', options: ['50', '100', 'It waits for tab 2'], answer: 0, explain: 'At read committed every statement sees what was committed when that statement began. Tab 2 committed in between, so the same query gives a different answer inside one transaction: a non-repeatable read.' }, sql: 'select bal from acct where id = 1;\ncommit;' },
      'Now the same thing at repeatable read. The transaction keeps the snapshot of its first statement:',
      { sql: 'begin isolation level repeatable read;\nselect bal from acct where id = 1;', note: 'In tab 1: reads 50.' },
      { sql: 'update acct set bal = 60 where id = 1;', tab: 2, note: 'In tab 2.' },
      { sql: 'select bal from acct where id = 1;', note: 'In tab 1: still 50.' },
      { h: 'Lost update' },
      'Not in the standard\'s table, but common. T1 now tries to change the row tab 2 changed after T1\'s snapshot:',
      { sql: 'update acct set bal = bal - 10 where id = 1;', fails: '40001', note: 'In tab 1: "could not serialize access due to concurrent update".' },
      { sql: 'rollback;', note: 'In tab 1. The application should now retry the whole transaction.' },
      'Repeatable read refuses to write over a change it could not see. At read committed the same pattern silently loses an update. Try it: both transactions read 60 and each writes a value computed from what it read.',
      { sql: 'begin;\nselect bal from acct where id = 1;', note: 'In tab 1: reads 60.' },
      { sql: 'begin;\nselect bal from acct where id = 1;', tab: 2, note: 'In tab 2: also reads 60.' },
      { sql: 'update acct set bal = 50 where id = 1;', note: 'In tab 1: withdraws 10 from what it read.' },
      { sql: 'update acct set bal = 40 where id = 1;', tab: 2, waits: true, note: 'In tab 2: withdraws 20. It waits for tab 1\'s row lock.' },
      { sql: 'commit;', note: 'In tab 1. Tab 2\'s update now goes ahead.' },
      { sql: 'commit;\nselect bal from acct where id = 1;', tab: 2, note: 'In tab 2: 40. Tab 1\'s withdrawal of 10 is lost.' },
      { h: 'Phantoms' },
      { sql: 'begin isolation level repeatable read;\nselect count(*) from acct where bal > 0;', note: 'In tab 1: counts 2.' },
      { sql: 'insert into acct values (3, 300);', tab: 2, note: 'In tab 2: a new row that matches.' },
      { sql: 'select count(*) from acct where bal > 0;\ncommit;', note: 'In tab 1: still 2. At read committed it would be 3, a phantom.' },
      { sql: 'drop table acct;', note: 'In tab 1.' },
      'Every anomaly here is also a ready-made scenario in the transactions view, which opens the tabs and runs the steps for you. Pick the isolation level in the view\'s menu before you set one up.',
      { view: 'txn', sel: { scenario: 'unrepeatable' }, label: 'Run the non-repeatable read scenario' },
      { view: 'txn', sel: { scenario: 'lost-update' }, label: 'Run the lost update scenario' },
      { tip: 'Serializable stops one more anomaly that the others allow: write skew. Chapter 18 shows it, and how PostgreSQL catches it.' },
    ],
  });

  lesson({
    id: 'tx-sql', chapter: 17, title: 'Transactions in SQL', minutes: 10,
    summary: 'BEGIN, COMMIT and ROLLBACK, autocommit, savepoints, read-only transactions, choosing an isolation level, and retrying after a serialization failure.',
    body: [
      'In SQL a transaction starts with `begin` (or `start transaction`) and ends with `commit` or `rollback`. Without `begin`, every statement is a transaction by itself: this is **autocommit**, and it is how the editor runs your queries unless you say otherwise.',
      { sql: "drop table if exists seat_hold;\ncreate table seat_hold (perf int, seat text, patron text, primary key (perf, seat));\nbegin;\ninsert into seat_hold values (7, 'C4', 'Okafor');\ninsert into seat_hold values (7, 'C5', 'Okafor');\ncommit;\nselect * from seat_hold;" },
      { h: 'Savepoints' },
      'A **savepoint** marks a point inside a transaction that you can roll back to without losing everything before it. It is useful when one step may fail and the rest should go on.',
      { sql: "begin;\ninsert into seat_hold values (7, 'C6', 'Lund');\nsavepoint before_second;\ninsert into seat_hold values (7, 'C4', 'Lund');", fails: '23505', note: 'The second insert asks for a seat Okafor already holds. The transaction is now failed.' },
      { predict: { q: 'Now run `rollback to savepoint before_second` and commit. Which of the two inserts survives?', options: ['The hold on C6, made before the savepoint', 'Neither', 'Both'], answer: 0, explain: 'Rolling back to the savepoint undoes only what came after it, and takes the transaction out of the failed state. The commit then keeps Lund\'s hold on C6.' }, sql: "rollback to savepoint before_second;\ncommit;\nselect * from seat_hold order by perf, seat;" },
      { h: 'Read-only transactions and isolation' },
      'A transaction can declare that it only reads. The database then refuses any write, and may run it more cheaply.',
      { sql: "begin read only;\ndelete from seat_hold;", fails: '25006' },
      { sql: 'rollback;' },
      'The isolation level is chosen per transaction, with `begin isolation level ...` or with `set transaction isolation level ...` as the first statement. `set default_transaction_isolation` changes the level for the session\'s later transactions.',
      { sql: "begin;\nset transaction isolation level serializable;\nshow transaction_isolation;\ncommit;\nshow transaction_isolation;" },
      { h: 'Retrying' },
      'At repeatable read and serializable a transaction can fail with SQLSTATE `40001`, a **serialization failure**, through no fault of its own. It must then run again from the start. A deadlock victim (`40P01`) is in the same position. Applications wrap such transactions in a loop: begin, do the work, commit, and on `40001` or `40P01` roll back and try again, a few times at most.',
      { list: ['Keep transactions short: the longer one runs, the more it conflicts.', 'Do not wait for a person inside a transaction: ask first, then begin.', 'Read what you need, decide, write, commit. Everything between begin and commit should be redoable.'] },
      { sql: 'drop table seat_hold;' },
    ],
  });

  // ---- exercises -----------------------------------------------------------------------------------------------------
  const sched = (s) => '`' + s + '`';
  const SA = 'r2(X) r1(Y) w2(X) r1(X) w1(Y) r3(Y) w3(Z) c1 c2 c3';
  const SB = 'r1(X) r2(Y) w2(X) r3(Z) w3(Y) w1(Z) c1 c2 c3';
  const SC = 'r3(Q) r1(P) w3(Q) r2(Q) w1(P) r2(P) w2(R) c1 c2 c3';
  const SD = 'r1(B) r2(A) w1(A) w2(A) w3(A) w3(B) c1 c2 c3';
  const FORMAT = 'Type your answer in the editor, then check it: `yes` followed by a serial order such as `yes, T2 T1 T3`, or just `no`.';
  C.exercise({
    id: 'ex17-cs-three', chapter: 17, title: 'Three transactions, one order', level: 1, kind: 'answer',
    text: ['Is this schedule conflict serializable? If it is, give an equivalent serial order.', { p: sched(SA) }, FORMAT],
    hints: ['List the pairs of conflicting operations: same item, different transactions, at least one write.', 'On X, `w2(X)` comes before `r1(X)`. On Y, `w1(Y)` comes before `r3(Y)`. The two reads of Y do not conflict.', 'The edges are T2 → T1 and T1 → T3, with no cycle. Answer: yes, T2 T1 T3'],
    solution: 'yes, T2 T1 T3', wrongs: ['yes, T1 T2 T3', 'no', 'yes'],
    ref: 'yes, T2 T1 T3. The precedence graph has T2 → T1 (w2(X) before r1(X)) and T1 → T3 (w1(Y) before r3(Y)); it is acyclic and T2, T1, T3 is its only topological order.',
    check: kit.serial(SA),
  });
  C.exercise({
    id: 'ex17-cs-cycle', chapter: 17, title: 'Around in a circle', level: 2, kind: 'answer',
    text: ['Is this schedule conflict serializable? If it is, give an equivalent serial order.', { p: sched(SB) }, FORMAT],
    hints: ['Each transaction touches two items. Look at X, Y and Z one at a time.', 'X gives T1 → T2, Y gives T2 → T3. What does Z give?', 'Z gives T3 → T1 (r3(Z) before w1(Z)), closing the cycle T1 → T2 → T3 → T1. Answer: no'],
    solution: 'no', wrongs: ['yes, T1 T2 T3', 'yes, T3 T1 T2'],
    ref: 'no. r1(X) before w2(X): T1 → T2. r2(Y) before w3(Y): T2 → T3. r3(Z) before w1(Z): T3 → T1. The cycle T1 → T2 → T3 → T1 means no serial order is conflict equivalent.',
    check: kit.serial(SB),
  });
  C.exercise({
    id: 'ex17-cs-two-roots', chapter: 17, title: 'More than one right order', level: 2, kind: 'answer',
    text: ['Is this schedule conflict serializable? If it is, give one equivalent serial order (there may be several).', { p: sched(SC) }, FORMAT],
    hints: ['Q gives one edge, P gives another; R is touched by one transaction only.', 'The edges are T3 → T2 and T1 → T2. Both T1 and T3 must come before T2, in either order.', 'One answer: yes, T3 T1 T2 (T1 T3 T2 is just as good)'],
    solution: 'yes, T3 T1 T2', alts: ['yes, T1 T3 T2'], wrongs: ['yes, T2 T1 T3', 'yes, T1 T2 T3', 'no'],
    ref: 'yes, T3 T1 T2 or T1 T3 T2. w3(Q) before r2(Q) gives T3 → T2; w1(P) before r2(P) gives T1 → T2. T1 and T3 do not conflict, so they can go in either order before T2.',
    check: kit.serial(SC),
  });
  C.exercise({
    id: 'ex17-edges', chapter: 17, title: 'Counting edges', level: 1, kind: 'answer',
    text: ['How many edges does the precedence graph of this schedule have? Count an edge Ti → Tj once, however many conflicts cause it.', { p: sched(SD) }, 'Type the number in the editor and check it.'],
    hints: ['A is touched by all three transactions, B by T1 and T3.', 'On A: r2(A) before w1(A) (T2 → T1), w1(A) before w2(A) (T1 → T2), and the writes before w3(A). On B: r1(B) before w3(B).', 'The edges are T1 → T2, T2 → T1, T1 → T3 and T2 → T3. Answer: 4'],
    solution: '4', wrongs: ['3', '5', '6'],
    ref: '4: T2 → T1 (r2(A), w1(A)), T1 → T2 (w1(A), w2(A)), T1 → T3 (w1(A), w3(A) and r1(B), w3(B)) and T2 → T3 (r2(A) or w2(A), w3(A)).',
    check: kit.number(4),
  });
  C.exercise({
    id: 'ex17-view', chapter: 17, title: 'Blind writes', level: 3, kind: 'answer',
    text: ['Is this schedule conflict serializable? Is it view serializable?', { p: sched('r1(X) w2(Y) w1(Y) w2(X) w3(X) w3(Y) c1 c2 c3') }, 'Type two words in the editor, for conflict and then view, such as `yes yes`, and check it.'],
    hints: ['Find a cycle in the precedence graph first: look at X, then at Y.', 'For view serializability, note what the one read sees (r1(X) sees the initial X) and who writes each item last (T3, for both). Is there a serial order with the same read and the same final writers?', 'Not conflict serializable (T1 → T2 on X, T2 → T1 on Y), but view equivalent to T1, T2, T3. Answer: no yes'],
    solution: 'no yes', wrongs: ['yes yes', 'no no'],
    ref: 'no yes. r1(X) before w2(X) gives T1 → T2, and w2(Y) before w1(Y) gives T2 → T1: a cycle. But in the serial schedule T1, T2, T3, r1(X) still reads the initial X and T3 still writes X and Y last. The writes of T2 and T1 to Y, and of T2 to X, are blind and overwritten unread.',
    check: kit.props('r1(X) w2(Y) w1(Y) w2(X) w3(X) w3(Y) c1 c2 c3', ['conflict', 'view']),
  });
  const RFORMAT = 'Type three words in the editor, for recoverable, cascadeless and strict in that order, such as `yes no no`, and check it.';
  C.exercise({
    id: 'ex17-rec-early', chapter: 17, title: 'Committing too early', level: 1, kind: 'answer',
    text: ['Is this schedule recoverable? Cascadeless? Strict?', { p: sched('w1(X) r2(X) w2(Y) c2 c1') }, RFORMAT],
    hints: ['T2 reads X from T1. When does each commit?', 'T2 commits before T1. If T1 then aborted, T2 could not be undone.', 'Not recoverable, so not cascadeless or strict either. Answer: no no no'],
    solution: 'no no no', wrongs: ['yes no no', 'yes yes no'],
    ref: 'no no no. T2 reads X written by T1 and commits first. Recoverable needs T1 to commit before T2; cascadeless and strict are stronger still.',
    check: kit.props('w1(X) r2(X) w2(Y) c2 c1'),
  });
  C.exercise({
    id: 'ex17-rec-wait', chapter: 17, title: 'Waiting for the commit', level: 2, kind: 'answer',
    text: ['Is this schedule recoverable? Cascadeless? Strict?', { p: sched('w1(A) w1(B) r2(B) c1 w2(A) c2') }, RFORMAT],
    hints: ['Look at each read of an item another transaction wrote, and whether the writer had committed at that moment.', 'r2(B) reads T1\'s B before c1. T1 commits before T2 does.', 'Recoverable (T1 commits first), not cascadeless (the read comes before c1), and so not strict. Answer: yes no no'],
    solution: 'yes no no', wrongs: ['yes yes yes', 'no no no', 'yes yes no'],
    ref: 'yes no no. T2 reads B from T1 while T1 is active, so an abort of T1 would cascade: not cascadeless, hence not strict. T1 commits before T2: recoverable. w2(A) after c1 is fine for strictness on its own.',
    check: kit.props('w1(A) w1(B) r2(B) c1 w2(A) c2'),
  });
  C.exercise({
    id: 'ex17-rec-overwrite', chapter: 17, title: 'Overwriting is not reading', level: 2, kind: 'answer',
    text: ['Is this schedule recoverable? Cascadeless? Strict?', { p: sched('r1(A) r2(A) w1(A) w2(A) c1 c2') }, RFORMAT],
    hints: ['Does any transaction read a value another transaction wrote?', 'Both reads see the initial A. But T2 writes A after T1 wrote it and before T1 ends.', 'Recoverable and cascadeless (no dirty reads), but not strict (w2(A) overwrites uncommitted data). Answer: yes yes no'],
    solution: 'yes yes no', wrongs: ['yes yes yes', 'no no no', 'yes no no'],
    ref: 'yes yes no. No transaction reads another\'s write, so recoverable and cascadeless hold trivially. Strictness also forbids overwriting an uncommitted write, and w2(A) comes after w1(A) but before c1.',
    check: kit.props('r1(A) r2(A) w1(A) w2(A) c1 c2'),
  });
  C.exercise({
    id: 'ex17-anomaly', chapter: 17, title: 'Name the anomaly', level: 1, kind: 'answer',
    text: ['Two tabs, both at read committed, run this in order. Tab 1: `begin; select count(*) from booking where perf_id = 41;`. Tab 2: `insert into booking ...` a new booking for performance 41 (autocommit). Tab 1: the same count again; `commit;`.', 'Which anomaly does tab 1 meet? Type one word in the editor: `dirty`, `nonrepeatable`, `phantom`, `lost` or `none`, and check it.'],
    hints: ['The row tab 2 adds did not exist when tab 1 first counted.', 'A non-repeatable read is about an existing row changing; this is a row appearing that matches the predicate.', 'A new row satisfying the predicate appears between two reads. Answer: phantom'],
    solution: 'phantom', wrongs: ['nonrepeatable', 'dirty', 'none'],
    ref: 'phantom: the second count includes a row that was inserted, and committed, after the first count. At read committed each statement takes a new snapshot, so it is visible.',
    check: kit.choice(['phantom'], ['dirty', 'nonrepeatable', 'phantom', 'lost', 'none']),
  });
  C.exercise({
    id: 'ex17-level', chapter: 17, title: 'The weakest level that will do', level: 2, kind: 'answer',
    text: ['A report reads the balance of every account twice inside one transaction and must see the same values both times, but it does not mind if accounts are added meanwhile. By the SQL standard\'s table, what is the weakest isolation level that guarantees this?', 'Type `uncommitted`, `committed`, `repeatable` or `serializable` in the editor and check it.'],
    hints: ['Seeing the same values for the same rows twice means no non-repeatable reads.', 'New accounts appearing are phantoms, which the report tolerates.', 'The standard prevents non-repeatable reads from repeatable read upward. Answer: repeatable'],
    solution: 'repeatable', wrongs: ['committed', 'serializable'],
    ref: 'repeatable (repeatable read). Read committed allows non-repeatable reads; repeatable read prevents them, while the standard still allows phantoms there. In PostgreSQL repeatable read prevents the phantoms as well.',
    check: kit.choice(['repeatable'], ['uncommitted', 'committed', 'repeatable', 'serializable']),
  });
})(typeof window !== 'undefined' ? window : globalThis);
