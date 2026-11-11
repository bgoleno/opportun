// The optional background WAL checkpointer (https://github.com/bgoleno/opportun/issues/383),
// SQLite only and off by default (OPPORTUN_SQLITE_BACKGROUND_CHECKPOINT=1).
//
// SQLite's automatic checkpoint runs inside whichever commit takes the WAL past its threshold, on
// the main connection, and better-sqlite3 is synchronous: the event loop waits for the copy and
// for the fsync of the database file. At 100 pages (db/client.ts) that is about 2 ms on an SSD,
// but on a slow disk (an SD card, a network volume) the fsync alone can pass 10 ms. With this on,
// the main connection runs no automatic checkpoint, and a worker thread runs PASSIVE checkpoints
// on its own connection. A PASSIVE checkpoint takes no lock a writer needs and never waits for
// one, so commits on the main thread go on while it copies and syncs.
//
// The trade-off: the WAL grows between checkpoints by whatever is written in an interval, and a
// reader that keeps a snapshot open stops a checkpoint from finishing, as it did before. If the
// worker stops for any reason, the caller is told (onStopped) and turns automatic checkpoints
// back on, so a dead worker can never leave the WAL to grow without bound.
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

/** How often the worker checkpoints, by default. */
export const CHECKPOINT_INTERVAL_MS = 1_000;

/** How long stop() lets the worker finish its checkpoint before ending it. */
const STOP_GRACE_MS = 5_000;

export interface CheckpointerStop {
  /** False when stop() ended it; true when the worker failed or exited by itself. */
  unexpected: boolean;
  err?: unknown;
}

export interface BackgroundCheckpointer {
  /** The pragmas the worker's connection runs before its first checkpoint. */
  readonly pragmas: readonly string[];
  /** Resolves once, when the worker has stopped, with why. */
  readonly stopped: Promise<CheckpointerStop>;
  /** Stops the worker after its current checkpoint and closes its connection. */
  stop(): Promise<void>;
}

/**
 * The worker, as CommonJS source: eval'd, so it needs no file of its own and no TypeScript
 * loader, whatever runs the server (tsx, vitest). It loads the same better-sqlite3 build by
 * its resolved path. A failure throws, which ends the worker and reaches the main thread as an
 * 'error' event: an unexpected stop.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const Database = require(workerData.driver);
const db = new Database(workerData.file, { fileMustExist: true });
for (const pragma of workerData.pragmas) db.pragma(pragma);
let timer;
const tick = () => {
  db.pragma('wal_checkpoint(PASSIVE)');
  timer = setTimeout(tick, workerData.intervalMs);
};
timer = setTimeout(tick, workerData.intervalMs);
parentPort.on('message', (message) => {
  if (message !== 'stop') return;
  clearTimeout(timer);
  db.close();
  parentPort.close();
});
`;

const driverPath = (): string => createRequire(import.meta.url).resolve('better-sqlite3');

/**
 * Starts a checkpointer on `file`. `pragmas` are the main connection's sync settings, so the
 * worker's checkpoints are as durable as the main connection's own would have been.
 */
export function startBackgroundCheckpointer(
  file: string,
  opts: {
    intervalMs?: number;
    pragmas: readonly string[];
    onStopped: (stop: CheckpointerStop) => void;
  },
): BackgroundCheckpointer {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      driver: driverPath(),
      file,
      pragmas: [...opts.pragmas],
      intervalMs: opts.intervalMs ?? CHECKPOINT_INTERVAL_MS,
    },
  });
  // Never what keeps the process alive: the server's close stops it, and a CLI's exit ends it.
  worker.unref();
  let stopping = false;
  let failure: unknown;
  worker.on('error', (err) => {
    failure = err;
  });
  const stopped = new Promise<CheckpointerStop>((resolve) => {
    worker.once('exit', () => {
      const stop: CheckpointerStop =
        stopping && failure === undefined
          ? { unexpected: false }
          : { unexpected: true, err: failure };
      opts.onStopped(stop);
      resolve(stop);
    });
  });
  return {
    pragmas: [...opts.pragmas],
    stopped,
    async stop() {
      if (!stopping) {
        stopping = true;
        worker.postMessage('stop');
        // A worker stuck in a checkpoint (a disk that does not answer) still ends.
        setTimeout(() => void worker.terminate(), STOP_GRACE_MS).unref();
      }
      await stopped;
    },
  };
}
