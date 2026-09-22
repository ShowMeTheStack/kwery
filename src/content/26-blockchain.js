// Chapter 26: blockchain databases. Hash chains and tamper evidence, Merkle trees, proof of work and forks, and
// how a blockchain differs from a database replicated with Raft.
(function (root) {
  'use strict';
  const C = root.K.Content;
  const kit = C.kit1726;
  const lesson = kit.lesson;

  const VERIFY = "select n,\n       hash = md5(n || '|' || payload || '|' || prev) as hash_ok,\n       coalesce(prev = lag(hash) over (order by n), true) as link_ok\nfrom ledger\norder by n;";

  lesson({
    id: 'bc-chain', chapter: 26, title: 'Hash chains, Merkle trees and tampering', minutes: 15,
    summary: 'Each block stores the hash of the block before it, so changing any old block breaks every link after it. Build a small chain in SQL, tamper with it, and catch the change with one query.',
    body: [
      'A blockchain is a log that many parties keep and nobody can quietly rewrite. Its main tool is the **cryptographic hash function**: a function that maps any input to a short digest, such that nobody can find two inputs with the same digest, or an input for a given digest, in any reasonable time. Change one character of the input and the digest changes completely.',
      { sql: "select md5('Ana pays Ben 5') as a,\n       md5('Ana pays Ben 6') as b;", note: 'One character apart; nothing in common. (Real blockchains use SHA-256; md5 is short enough to read here, and the idea is the same.)' },
      { def: 'Hash pointer.', text: 'A reference to a piece of data together with the hash of that data. Following it you find the data; recomputing the hash tells you whether the data has changed since the pointer was made.' },
      'A **blockchain** is a list of blocks linked by hash pointers: every block holds the hash of the block before it. Here is one, built in a table. Each block\'s hash covers its number, its payload and the hash of the previous block:',
      { sql: "drop table if exists ledger;\ncreate table ledger (n int primary key, payload text not null, prev text not null, hash text not null);\ninsert into ledger\nwith recursive tx(n, payload) as (\n  values (1, 'Ana pays Ben 5'), (2, 'Ben pays Cara 3'), (3, 'Cara pays Dev 2'), (4, 'Dev pays Ana 1')),\nchain(n, payload, prev, hash) as (\n  select 0, 'genesis'::text, repeat('0', 32), md5('0|genesis|' || repeat('0', 32))\n  union all\n  select t.n, t.payload, c.hash, md5(t.n || '|' || t.payload || '|' || c.hash)\n  from chain c join tx t on t.n = c.n + 1)\nselect * from chain;\nselect n, payload, left(prev, 8) as prev, left(hash, 8) as hash from ledger order by n;", note: 'Block 0, the **genesis** block, points at nothing (all zeros). Each later prev is the hash of the row above.' },
      'Verifying the chain takes two checks per block: does the block hash to its stored hash, and does its prev match the previous block\'s hash? A window function does both in one pass:',
      { sql: VERIFY },
      { h: 'Tampering' },
      'Someone with write access changes an old payment:',
      { sql: "update ledger set payload = 'Ana pays Ben 500' where n = 1;\n" + VERIFY, note: 'Block 1 no longer hashes to its stored hash.' },
      { predict: { q: 'The tamperer now recomputes block 1\'s hash so that it matches its new payload. Run the verification again: which check fails?', options: ['The link of block 2: its prev still holds block 1\'s old hash', 'None: the chain verifies again', 'The hash of block 1'], answer: 0, explain: 'Block 1 is self-consistent again, but block 2 still points at the old hash. To hide the change the tamperer must recompute block 2, which breaks block 3, and so on to the end of the chain, and everyone else still holds the old last hash.' }, sql: "update ledger set hash = md5(n || '|' || payload || '|' || prev) where n = 1;\n" + VERIFY },
      'This is **tamper evidence**, not tamper proofing: the change is possible, but it cannot go unnoticed by anyone who kept the hash of the last block. A blockchain makes rewriting expensive as well, with proof of work, the next lesson.',
      { h: 'Merkle trees' },
      'A block holds many transactions. Rather than hash them as one blob, a block stores the root of a **Merkle tree**: hash each transaction, then hash pairs of hashes, then pairs of those, up to a single root. The root in the block header commits to every transaction.',
      { sql: "with leaf as (\n  select n, md5(payload) as h from ledger where n between 1 and 4),\nlevel1 as (\n  select (n + 1) / 2 as n, md5(string_agg(h, '' order by n)) as h\n  from leaf group by (n + 1) / 2)\nselect md5(string_agg(h, '' order by n)) as merkle_root from level1;", note: 'Four leaves, two pairs, one root.' },
      'The tree pays off when a light client, such as a phone wallet, wants to know whether one transaction is in a block without downloading the block. A **Merkle proof** gives it the sibling hash at each level, from the leaf up: it hashes its way to the root and compares with the root in the header. For n transactions the proof holds about log₂ n hashes: 10 hashes for a thousand transactions.',
      { view: 'blockchain', label: 'Open the Blockchain view' },
      { steps: ['In the **Chain** part, click a block in the strip. Its panel lists the header (prev, nonce, Merkle root, hash) and the transactions.', 'Click a transaction label such as **T1**: the Merkle proof of that transaction is drawn, sibling by sibling.', 'Change an amount in the block\'s transactions. The block is marked tampered and every later block is marked as after a break. Press **Verify** to see where checking fails.', 'Press **Mine it again** on the changed block: it becomes valid, and the next block breaks instead. **Repair the rest** re-mines every later block; watch how many hashes that takes.'] },
      { sql: 'drop table ledger;' },
    ],
  });

  lesson({
    id: 'bc-consensus', chapter: 26, title: 'Proof of work, forks, and a blockchain against Raft', minutes: 12,
    summary: 'Proof of work makes adding a block costly and checking it cheap; the longest chain wins when miners disagree. A database replicated with Raft keeps an ordered log too, but trusts its servers and is final at once.',
    body: [
      'In an open network anyone may propose the next block. Something must decide whose block goes next and make rewriting history too expensive. Bitcoin\'s answer is **proof of work**: a block is valid only if its hash, computed over the header with a number called the **nonce**, falls below a target, here pictured as "starts with d zero hex digits". The only way to find such a nonce is to try one after another.',
      { sql: "select nonce, md5('Ana pays Ben 5|' || nonce) as hash\nfrom generate_series(0, 3000) as nonce\nwhere left(md5('Ana pays Ben 5|' || nonce), 2) = '00'\norder by nonce\nlimit 3;", note: 'Two zero hex digits: about one hash in 16² = 256 qualifies. Here the first is nonce 83, the next 282 and 472: luck varies, but on average it takes 256 tries.' },
      { predict: { q: 'Each extra zero digit in the target multiplies the expected number of attempts by what?', options: ['16', '2', '10'], answer: 0, explain: 'A hex digit has 16 values, so a hash starts with one more zero with probability 1/16. Two zeros need about 256 tries, three about 4,096, four about 65,536. Checking a claimed nonce still takes one hash.' }, sql: "select d as zeros, power(16, d) as expected_attempts\nfrom generate_series(1, 5) as d;" },
      'That asymmetry is the point: **finding** a nonce is slow, **checking** it is one hash. To rewrite a block deep in the chain, an attacker must redo its proof of work and that of every later block, faster than all honest miners together keep extending the chain. As long as honest miners control most of the computing power, they win the race.',
      { h: 'Forks and the longest chain' },
      'Two miners can find a valid next block at nearly the same moment. Different nodes then hold different chains: a **fork**. Each node follows the **longest-chain rule**: it builds on the longest valid chain it knows. As soon as one branch gets a further block, it is longer, and every node switches to it; the transactions in the losing block go back to the pool. So a block is never final with certainty; it becomes safer with each block built on top of it (Bitcoin users often wait for six).',
      { view: 'blockchain', label: 'Open the Blockchain view' },
      { steps: ['In the **Chain** part, add two transfers to the pool and press **Mine a block**. Raise the **Difficulty** by one zero and mine again: the attempts grow about sixteen-fold.', 'Switch to **Forks**. Press **A and B mine at once**: the chain forks and the nodes disagree.', 'Press **A mines**. A\'s branch is longer, so B and C switch to it; B\'s block becomes stale and its transfers return to the pool.', 'Switch to **vs. Raft** for the comparison table, and use **Open the Raft cluster** to watch Raft commit the same kind of log.'] },
      { h: 'A blockchain against a replicated database' },
      'Raft (chapter 23) also keeps one ordered log on many servers. The difference is what each assumes about the participants:',
      { table: [['', 'Blockchain (proof of work)', 'Database replicated with Raft'], ['Participants', 'open, possibly anonymous, mutually distrustful', 'a known set of servers'], ['Faults', 'Byzantine: nodes may lie', 'crashes and lost messages only'], ['Agreement', 'proof of work and the longest chain', 'an elected leader and majority acknowledgement'], ['Finality', 'probabilistic, grows with each block', 'immediate once a majority stores the entry'], ['Cost', 'enormous computing effort', 'a few messages per entry'], ['Throughput', 'a few transactions per second', 'thousands per second']] },
      'Between the two sit **permissioned** blockchains: known members, no mining, and a Byzantine fault-tolerant protocol such as PBFT to agree on blocks. They suit groups of organizations that must share a ledger but do not want any one of them to own it.',
      { predict: { q: 'A theatre company wants a ledger of ticket refunds that its own box office runs, with fast queries and immediate commits. What fits best?', options: ['A database replicated with Raft, with an audit log', 'A public proof-of-work blockchain', 'A permissionless blockchain with a smart contract'], answer: 0, explain: 'One organization is trusted to run the system, so there is no need to defend against Byzantine participants. Raft gives immediate, durable commits and full SQL; a hash-chained audit table can still make tampering evident.' } },
      'A small taste of that last idea: a log of refunds in which each row carries the hash of the previous one is a hash chain inside an ordinary database.',
      { sql: "drop table if exists refund_log;\ncreate table refund_log (n int primary key, change text, prev text, hash text);\ninsert into refund_log values (1, 'booking 412: refund 39.00', repeat('0', 32), md5('1|booking 412: refund 39.00|' || repeat('0', 32)));\ninsert into refund_log\n  select 2, c, g.hash, md5('2|' || c || '|' || g.hash)\n  from refund_log g, (values ('booking 87: refund 117.00')) as v(c) where g.n = 1;\nselect n, change, left(hash, 8) as hash from refund_log order by n;\ndrop table refund_log;" },
    ],
  });

  // ---- exercises --------------------------------------------------------------------------------------------------
  C.exercise({
    id: 'ex26-tamper', chapter: 26, level: 2, kind: 'answer', title: 'Where does the chain break?',
    text: ['A chain has blocks 0 to 7, verified as in the lesson: each block\'s hash covers its own contents and its prev field, and prev must equal the hash of the block before.', 'An attacker changes the payload of block 3, then recomputes the stored hash of block 3 and of block 4 (setting block 4\'s prev to block 3\'s new hash first). Nothing else changes.', 'Which is the first block whose check fails? Type its number.'],
    hints: ['Blocks 3 and 4 now hash correctly and block 4\'s prev matches the new hash of block 3.', 'Block 4\'s stored hash changed, because its prev changed. Who points at block 4?', 'Block 5\'s prev still holds block 4\'s old hash: block 5 is the first to fail.'],
    solution: '5', wrongs: ['3', '4', '7'], ref: 'Block 5: its prev is the old hash of block 4, which no longer matches block 4\'s recomputed hash.',
    check: kit.number(5),
  });
  C.exercise({
    id: 'ex26-pow', chapter: 26, level: 1, kind: 'answer', title: 'The work in proof of work',
    text: ['A block is valid when its hash, written in hexadecimal, starts with 3 zero digits. Each nonce tried gives an unpredictable hash.', 'How many nonces must a miner try, on average, to find a valid block? Type one number.'],
    hints: ['A hex digit takes 16 values, all equally likely.', 'The chance of three leading zeros is (1/16)³.', 'On average 16³ = 4096 tries.'],
    solution: '4096', wrongs: ['48', '256', '1000'], ref: 'P(three leading zero hex digits) = 16^−3, so the expected number of tries is 16³ = 4096.',
    check: kit.number(4096),
  });
  C.exercise({
    id: 'ex26-merkle', chapter: 26, level: 2, kind: 'answer', title: 'The size of a Merkle proof',
    text: ['A block holds 1,024 transactions in a Merkle tree (a full binary tree of hashes). A light client wants to check that one transaction is in the block, knowing only the Merkle root from the block header.', 'How many hashes must the proof give it, besides the hash of the transaction itself? Type one number.'],
    hints: ['The proof gives one sibling hash at each level, from the leaf up to the level below the root.', 'A full binary tree with 1,024 leaves has log₂ 1024 levels of pairing.', 'log₂ 1024 = 10 hashes.'],
    solution: '10', wrongs: ['1024', '512', '11'], ref: 'One sibling per level: log₂ 1024 = 10 hashes.',
    check: kit.number(10),
  });
})(typeof window !== 'undefined' ? window : globalThis);
