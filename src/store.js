// -----------------------------------------------------------------------------
// What the integration keeps across restarts in /data (the one writable
// volume): the known boxes by serial number (address, model) and the time of
// the last read round, so that a restart never reads sooner than the
// interval, and the guard of a wake-up or standby just sent (wall-clock time
// and duration), so that a restart does not forget it. No secret: a box needs none. One write at a time, through a
// temporary file and a rename.
//
// A file that exists but cannot be read is never overwritten (`problem:
// 'unreadable'`, no save); a file that is not valid JSON is moved aside to
// `.bad` and reported (`problem: 'corrupt'`).
// -----------------------------------------------------------------------------

import { readFileSync, renameSync, statSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const emptyData = () => ({ boxes: {}, lastAttemptAt: undefined, toggleGuards: {} });
const MAX_BYTES = 256 * 1024;
const SERIAL = /^[A-Za-z0-9-]{4,40}$/;

function sanitize(raw) {
  const data = emptyData();
  if (raw && typeof raw === 'object' && raw.boxes && typeof raw.boxes === 'object') {
    for (const [serial, box] of Object.entries(raw.boxes)) {
      if (SERIAL.test(serial) && box && typeof box === 'object' && box.serial === serial) {
        data.boxes[serial] = {
          serial,
          host: typeof box.host === 'string' ? box.host.slice(0, 253) : '',
          model: typeof box.model === 'string' ? box.model.slice(0, 64) : undefined,
        };
      }
    }
  }
  const guards = raw?.toggleGuards;
  if (guards && typeof guards === 'object') {
    for (const [serial, guard] of Object.entries(guards)) {
      if (
        SERIAL.test(serial) &&
        guard &&
        Number.isFinite(guard.wallAt) &&
        Number.isFinite(guard.ms) &&
        guard.ms > 0 &&
        guard.ms <= 10 * 60_000 &&
        typeof guard.on === 'boolean'
      ) {
        data.toggleGuards[serial] = { wallAt: guard.wallAt, ms: guard.ms, on: guard.on };
      }
    }
  }
  if (Number.isFinite(raw?.lastAttemptAt)) {
    data.lastAttemptAt = raw.lastAttemptAt;
  }
  return data;
}

export class FileStore {
  constructor({ dir = process.env.DATA_DIR || '/data', name = 'sky-q.json' } = {}) {
    this.path = join(dir, name);
    this.queue = Promise.resolve();
  }

  /** @returns {{ data: object, problem?: 'unreadable' | 'corrupt' }} */
  load() {
    let text;
    try {
      if (statSync(this.path).size > MAX_BYTES) {
        return { data: emptyData(), problem: 'unreadable' };
      }
      text = readFileSync(this.path, 'utf8');
    } catch (err) {
      return err?.code === 'ENOENT'
        ? { data: emptyData() }
        : { data: emptyData(), problem: 'unreadable' };
    }
    try {
      return { data: sanitize(JSON.parse(text)) };
    } catch {
      try {
        renameSync(this.path, `${this.path}.bad`);
      } catch {
        return { data: emptyData(), problem: 'unreadable' };
      }
      return { data: emptyData(), problem: 'corrupt' };
    }
  }

  save(data) {
    const write = async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
      await rename(temporary, this.path);
    };
    const job = this.queue.then(write, write);
    this.queue = job.catch(() => {});
    return job;
  }
}

/** For the tests. */
export class MemoryStore {
  constructor(data = emptyData(), { problem, failSave = false } = {}) {
    this.data = structuredClone(data);
    this.problem = problem;
    this.failSave = failSave;
    this.saves = 0;
  }

  load() {
    return { data: sanitize(structuredClone(this.data)), problem: this.problem };
  }

  async save(data) {
    if (this.failSave) {
      throw new Error('disk full');
    }
    this.data = structuredClone(data);
    this.saves += 1;
  }
}
