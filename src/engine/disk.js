// The simulated disk: files of fixed-size blocks, and a timing model (a magnetic disk with seeks and
// rotation, or an SSD), so every block read and write has a cost the views can show and add up.
(function (root) {
  'use strict';
  const K = root.K;

  const MODELS = {
    // Kwery's magnetic disk: 7200 rpm, so the average rotational latency (half a turn) is 4.17 ms; with an average
    // seek of 1.83 ms a random block access costs tS = 6 ms. A 4 KB block transfers in tT = 0.15 ms (about
    // 27.3 MB/s), so tS = 40 tT
    hdd: { name: 'Magnetic disk', rpm: 7200, seekMs: 1.83, rotMs: 4.17, mbps: 4096 / 150, trackBlocks: 256, kind: 'hdd' },
    // an NVMe SSD: no seeks, 0.1 ms latency, 2 GB/s; writes erase in blocks of 64 pages
    ssd: { name: 'SSD (NVMe)', seekMs: 0, rotMs: 0, latencyMs: 0.1, mbps: 2000, eraseBlocks: 64, kind: 'ssd' },
  };

  class Disk {
    constructor(opts) {
      opts = opts || {};
      this.pageSize = opts.pageSize || 4096;
      this.model = MODELS[opts.model || 'hdd'];
      this.files = new Map();     // file id -> { name, blocks: [Uint8Array] }
      this.nextFile = 1;
      this.head = { file: 0, block: -1 }; // where the disk arm last was, for seek costs
      this.stats = { reads: 0, writes: 0, seeks: 0, ms: 0, bytesRead: 0, bytesWritten: 0 };
      this.bus = opts.bus || new K.Bus();
      this.failing = false;       // set by crash simulations: a torn write stops half way
    }
    setModel(id) { if (!MODELS[id]) throw K.err(K.STATE.invalidParameter, 'unknown disk model ' + id); this.model = MODELS[id]; }
    createFile(name, kind) {
      const id = this.nextFile++;
      this.files.set(id, { id, name, kind: kind || 'heap', blocks: [] });
      this.bus.emit('disk.create', { file: id, name });
      return id;
    }
    dropFile(id) { this.files.delete(id); this.bus.emit('disk.drop', { file: id }); }
    file(id) { const f = this.files.get(id); if (!f) throw K.err(K.STATE.internal, 'no such file ' + id); return f; }
    blocks(id) { return this.file(id).blocks.length; }
    extend(id) {
      const f = this.file(id);
      f.blocks.push(new Uint8Array(this.pageSize));
      this.bus.emit('disk.extend', { file: id, block: f.blocks.length - 1 });
      return f.blocks.length - 1;
    }
    truncate(id, n) { const f = this.file(id); f.blocks.length = n; }
    /** recovery: make sure a file (by its id) and a block exist, as replaying the log onto a restored disk needs */
    ensure(id, block, name, kind) {
      if (!this.files.has(id)) { this.files.set(id, { id, name: name || 'file ' + id, kind: kind || 'heap', blocks: [] }); if (this.nextFile <= id) this.nextFile = id + 1; }
      const f = this.files.get(id);
      while (block !== undefined && f.blocks.length <= block) f.blocks.push(new Uint8Array(this.pageSize));
      return f;
    }
    /** the time one access takes: a seek unless it continues where the head is, plus rotation and transfer */
    cost(file, block) {
      const m = this.model;
      const xfer = (this.pageSize / (m.mbps * 1e6)) * 1000;
      if (m.kind === 'ssd') return { ms: m.latencyMs + xfer, seek: false };
      const sequential = this.head.file === file && block === this.head.block + 1;
      const sameTrack = this.head.file === file && Math.floor(block / m.trackBlocks) === Math.floor(this.head.block / m.trackBlocks);
      const seek = !sequential;
      return { ms: (seek ? (sameTrack ? 0 : m.seekMs) + m.rotMs : 0) + xfer, seek };
    }
    read(file, block, into) {
      const f = this.file(file);
      if (block >= f.blocks.length) throw K.err(K.STATE.internal, 'read past the end of file ' + f.name + ': block ' + block);
      const c = this.cost(file, block);
      this.stats.reads++; this.stats.ms += c.ms; this.stats.bytesRead += this.pageSize; if (c.seek) this.stats.seeks++;
      this.head = { file, block };
      into.set(f.blocks[block]);
      this.bus.emit('disk.read', { file, block, ms: c.ms, seek: c.seek, name: f.name });
    }
    write(file, block, from) {
      const f = this.file(file);
      while (block >= f.blocks.length) f.blocks.push(new Uint8Array(this.pageSize));
      const c = this.cost(file, block);
      this.stats.writes++; this.stats.ms += c.ms; this.stats.bytesWritten += this.pageSize; if (c.seek) this.stats.seeks++;
      this.head = { file, block };
      if (this.failing) {
        // a torn page: only the first part reaches the platter (half, or the sectors given by failing.tearAt)
        const cut = typeof this.failing === 'object' && this.failing.tearAt ? this.failing.tearAt : this.pageSize / 2;
        f.blocks[block].set(from.subarray(0, cut));
        this.failing = false;
        this.bus.emit('disk.torn', { file, block });
        throw new K.Crash('crash while writing block ' + block + ' of ' + f.name);
      }
      f.blocks[block].set(from);
      this.bus.emit('disk.write', { file, block, ms: c.ms, seek: c.seek, name: f.name });
    }
    /**
     * temporary-file I/O of an external sort or a partitioned hash join: a run of pages written or read in one
     * sequential sweep (one seek on a magnetic disk), counted and timed like page I/O; nothing is stored
     */
    temp(op, pages, what) {
      if (!(pages > 0)) return;
      const m = this.model, xfer = (this.pageSize / (m.mbps * 1e6)) * 1000;
      const ms = m.kind === 'ssd' ? pages * (m.latencyMs + xfer) : m.seekMs + m.rotMs + pages * xfer;
      if (op === 'read') { this.stats.reads += pages; this.stats.bytesRead += pages * this.pageSize; } else { this.stats.writes += pages; this.stats.bytesWritten += pages * this.pageSize; }
      if (m.kind !== 'ssd') this.stats.seeks++;
      this.stats.ms += ms;
      this.head = { file: 0, block: -1 };
      this.bus.emit('disk.temp', { op, pages, what, ms });
    }
    resetStats() { this.stats = { reads: 0, writes: 0, seeks: 0, ms: 0, bytesRead: 0, bytesWritten: 0 }; }
    /** a copy of every file, for snapshots (step back across a crash) and saving to the browser */
    snapshot() { return { pageSize: this.pageSize, next: this.nextFile, files: [...this.files.values()].map((f) => ({ id: f.id, name: f.name, kind: f.kind, blocks: f.blocks.map((b) => b.slice()) })) }; }
    restore(s) {
      this.pageSize = s.pageSize; this.nextFile = s.next;
      this.files = new Map(s.files.map((f) => [f.id, { id: f.id, name: f.name, kind: f.kind, blocks: f.blocks.map((b) => b.slice()) }]));
    }
  }

  /**
   * the page checksum kept in pd_checksum (bytes 8-9): FNV-1a over the whole page with the checksum field read as
   * zero, folded to 16 bits and never 0, so 0 can mean "no checksum" (a page never written, or checksums off).
   * A torn write leaves a page whose two halves come from different versions: the sum no longer matches.
   */
  function checksum(b) {
    let h = 0x811c9dc5;
    for (let i = 0; i < b.length; i++) { h ^= i === 8 || i === 9 ? 0 : b[i]; h = Math.imul(h, 0x01000193); }
    return (((h >>> 16) ^ h) & 0xffff) || 1;
  }
  function checksumOk(b) { const stored = b[8] | (b[9] << 8); return stored === 0 || stored === checksum(b); }
  function setChecksum(b, on) { const c = on ? checksum(b) : 0; b[8] = c & 0xff; b[9] = c >>> 8; return c; }

  /** thrown to simulate a power failure: everything not on the disk is lost */
  class Crash extends Error { constructor(msg) { super(msg); this.crash = true; } }

  K.Disk = Disk;
  K.Crash = Crash;
  K.pageChecksum = checksum;
  K.checksumOk = checksumOk;
  K.setChecksum = setChecksum;
  K.DISK_MODELS = MODELS;
})(typeof window !== 'undefined' ? window : globalThis);
