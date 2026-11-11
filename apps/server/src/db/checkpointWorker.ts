// The background WAL checkpointer's worker thread (db/checkpointer.ts,
// https://github.com/bgoleno/opportun/issues/383). It runs with tsx as its loader, as the image
// runs the server, whatever started the parent (checkpointer.ts passes it), and the tests import
// readWalIndex from it, the one piece that depends on SQLite's internals.
//
// It checkpoints by WAL size, not by the clock: a checkpoint that completes makes the next write
// on the main connection restart the WAL, and that restart (with its sync) runs on the main
// thread. Checkpointing every second made nearly every quiet write pay it (tl on #393). So the
// worker runs a PASSIVE checkpoint only when `maxPages` frames wait to be copied, or when
// anything has waited `maxWaitMs`: with synchronous=NORMAL a commit is synced only at a
// checkpoint, so the age bound is what keeps a quiet server's commits from waiting hours for one.
import { endianness } from 'node:os';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { readOperatorBytesAt } from '../lib/storage';

/**
 * The wal-index header's version field, the same since SQLite 3.7.0. The wal-index (the -shm
 * file) is described in SQLite's WAL file format documentation ("The WAL-Index Format"): two
 * copies of a 48-byte header, then the checkpoint information, in the machine's native byte
 * order. Its layout is not promised stable across releases, so readWalIndex refuses anything
 * it does not recognise, and sqliteCheckpointer.test.ts pins it against SQLite's own figures: a
 * better-sqlite3 upgrade that changes it fails that test.
 */
export const WAL_INDEX_VERSION = 3007000;
const HEADER_BYTES = 48;
/** The fields read, by their byte offsets in the header. */
const AT_VERSION = 0;
const AT_IS_INIT = 12;
const AT_PAGE_SIZE = 14;
const AT_MX_FRAME = 16;
/** WalCkptInfo follows the two header copies; nBackfill is its first field. */
const AT_N_BACKFILL = 2 * HEADER_BYTES;
const READ_BYTES = AT_N_BACKFILL + 4;
/** A torn read (SQLite updating the header as it is read) is retried this many times. */
const READ_ATTEMPTS = 5;

export interface WalIndex {
  /** Frames in the WAL. */
  mxFrame: number;
  /** Of those, frames already copied into the database. */
  nBackfill: number;
}

/**
 * The WAL's frame count and how many of them are copied into the database, from the wal-index
 * header of the -shm file at `path`, or undefined when it cannot tell: a short read, a header it
 * does not recognise, two copies that never agree, or more frames copied than exist. It reads
 * without the lock SQLite's own readers take, so it takes a reading only when both copies of the
 * header are equal, as SQLite's readers do.
 */
export function readWalIndex(path: string, pageSize: number): WalIndex | undefined {
  const little = endianness() === 'LE';
  const u16 = (b: Buffer, at: number) => (little ? b.readUInt16LE(at) : b.readUInt16BE(at));
  const u32 = (b: Buffer, at: number) => (little ? b.readUInt32LE(at) : b.readUInt32BE(at));
  // szPage holds a 65,536-byte page as 1 (SQLite stores (size & 0xff00) | (size >> 16)).
  const expectedPageSize = (pageSize & 0xff00) | (pageSize >> 16);
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    const b = readOperatorBytesAt(path, 0, READ_BYTES);
    if (b === undefined || b.length < READ_BYTES) return undefined;
    if (!b.subarray(0, HEADER_BYTES).equals(b.subarray(HEADER_BYTES, 2 * HEADER_BYTES))) continue;
    if (u32(b, AT_VERSION) !== WAL_INDEX_VERSION || b.readUInt8(AT_IS_INIT) !== 1) {
      return undefined;
    }
    const mxFrame = u32(b, AT_MX_FRAME);
    const nBackfill = u32(b, AT_N_BACKFILL);
    // An empty WAL (a database closed cleanly and opened again, before its first write) has an
    // initialised header whose page size is not set yet: nothing waits (tl on #393).
    const empty = mxFrame === 0 && u16(b, AT_PAGE_SIZE) === 0;
    if (!empty && u16(b, AT_PAGE_SIZE) !== expectedPageSize) return undefined;
    if (mxFrame < nBackfill) continue;
    return { mxFrame, nBackfill };
  }
  return undefined;
}

/** What the parent passes (checkpointer.ts). */
export interface CheckpointWorkerData {
  checkpointer: true;
  file: string;
  pragmas: string[];
  pageSize: number;
  maxPages: number;
  maxWaitMs: number;
  pollMs: number;
  retryMs: number;
}

/** What the worker tells the parent. */
export type CheckpointWorkerMessage =
  | {
      type: 'ready';
      settings: { synchronous: unknown; fullfsync: unknown; checkpoint_fullfsync: unknown };
    }
  | {
      type: 'checkpoint';
      reason: 'size' | 'age';
      /** When it started, as Date.now(): the benchmark lines a write's stall up against it. */
      startedAt: number;
      log: number;
      checkpointed: number;
      ms: number;
    };

function run(data: CheckpointWorkerData, port: NonNullable<typeof parentPort>): void {
  const db = new Database(data.file, { fileMustExist: true });
  for (const pragma of data.pragmas) db.pragma(pragma);
  const tell = (message: CheckpointWorkerMessage) => port.postMessage(message);
  tell({
    type: 'ready',
    settings: {
      synchronous: db.pragma('synchronous', { simple: true }),
      fullfsync: db.pragma('fullfsync', { simple: true }),
      checkpoint_fullfsync: db.pragma('checkpoint_fullfsync', { simple: true }),
    },
  });
  // The one file this reads: the database's own -shm, from the database path db/client.ts opened
  // (SQLITE_DIR/opportun.db), never a path from a request or any other input (NFR-SEC11: the
  // read goes through lib/storage.ts).
  const shm = `${data.file}-shm`;
  let waitingSince: number | undefined;
  let lastAttempt = -Infinity;
  // Whether the last checkpoint left frames behind (a reader held them): only then is the next
  // attempt delayed. A checkpoint that copied everything is followed at once by the next one the
  // WAL calls for, or under steady writes the backstop would do the worker's job, on the main
  // thread (the busy benchmark caught that).
  let heldBack = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = (): void => {
    const index = readWalIndex(shm, data.pageSize);
    // Cannot tell: the worker ends, an unexpected stop, and the main connection goes back to its
    // own automatic checkpoints (db/client.ts).
    if (index === undefined) throw new Error('the wal-index header cannot be read');
    const waiting = index.mxFrame - index.nBackfill;
    const now = Date.now();
    if (waiting === 0) waitingSince = undefined;
    else waitingSince ??= now;
    const reason =
      waiting >= data.maxPages
        ? 'size'
        : waitingSince !== undefined && now - waitingSince >= data.maxWaitMs
          ? 'age'
          : undefined;
    // A checkpoint that a reader held back is retried, but not on every poll.
    if (reason !== undefined && (!heldBack || now - lastAttempt >= data.retryMs)) {
      lastAttempt = now;
      const startedAt = Date.now();
      const started = performance.now();
      const [result] = db.pragma('wal_checkpoint(PASSIVE)') as {
        log: number;
        checkpointed: number;
      }[];
      const log = result?.log ?? -1;
      const checkpointed = result?.checkpointed ?? -1;
      if (log < 0) {
        // Another connection held the checkpoint lock (the backstop, or a backup's own): this
        // did nothing, so it is not reported as a checkpoint, and it is tried again later.
        heldBack = true;
      } else {
        heldBack = checkpointed < log;
        // A checkpoint that copied everything leaves no frame waiting: the age bound starts
        // again with the next frame written, or a steady writer would find something waiting on
        // every poll and the bound, once passed, would checkpoint on every poll (tl on #393).
        if (!heldBack) waitingSince = undefined;
        tell({
          type: 'checkpoint',
          reason,
          startedAt,
          log,
          checkpointed,
          ms: performance.now() - started,
        });
        // Look again at once: a burst may have written another threshold's worth meanwhile, and
        // the less the worker lags, the less a backstop firing has to copy (tl on #393).
        timer = setTimeout(tick, 0);
        return;
      }
    }
    timer = setTimeout(tick, data.pollMs);
  };
  timer = setTimeout(tick, data.pollMs);
  port.on('message', (message) => {
    if (message !== 'stop') return;
    clearTimeout(timer);
    db.close();
    port.close();
  });
}

const data = workerData as CheckpointWorkerData | null;
if (!isMainThread && parentPort !== null && data?.checkpointer === true) run(data, parentPort);
