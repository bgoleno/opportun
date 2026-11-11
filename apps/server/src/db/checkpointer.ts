// The optional background WAL checkpointer (https://github.com/bgoleno/opportun/issues/383),
// SQLite only and off by default (OPPORTUN_SQLITE_BACKGROUND_CHECKPOINT=1).
//
// SQLite's automatic checkpoint runs inside whichever commit takes the WAL past its threshold, on
// the main connection, and better-sqlite3 is synchronous: the event loop waits for the copy and
// for the sync of the database file. At 100 pages (db/client.ts) that is about 2 ms on an SSD,
// but on a slow disk (an SD card) the sync alone can pass 10 ms. With this on, a worker thread
// runs PASSIVE checkpoints on a connection of its own (db/checkpointWorker.ts), when CHECKPOINT_PAGES
// pages wait to be copied or when anything has waited CHECKPOINT_MAX_WAIT_MS. A PASSIVE
// checkpoint takes no lock a writer needs and never waits for one, so commits on the main thread
// go on while it copies and syncs.
//
// What stays on the main thread: after a checkpoint that copied everything, the next write
// restarts the WAL, and that restart's sync is the writer's. Checkpointing by size, the main
// thread restarts the WAL about once per CHECKPOINT_PAGES pages written, about a tenth as often
// as at the default 100 (tl on #393). The main connection keeps its own automatic checkpoint as
// a backstop at BACKSTOP_PAGES (db/client.ts): under a write rate the worker cannot keep up with,
// SQLite restarts the WAL only when a writer finds all of it copied, and without the backstop it
// grew 5 MB a second.
//
// If the worker stops for any reason, the caller is told (onStopped) and the main connection
// goes back to its default, so a dead worker can never leave the WAL to grow without bound.
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { CheckpointWorkerData, CheckpointWorkerMessage } from './checkpointWorker';

/** A checkpoint runs once this many pages wait to be copied. */
export const CHECKPOINT_PAGES = 1_000;
/** Or once anything has waited this long: a commit is synced only at a checkpoint. */
export const CHECKPOINT_MAX_WAIT_MS = 60_000;
/** How often the worker reads the WAL's size. */
const POLL_MS = 100;
/** How soon a checkpoint a reader held back is tried again. */
const RETRY_MS = 1_000;
/** How long stop() lets the worker finish its checkpoint before ending it. */
const STOP_GRACE_MS = 5_000;

export interface CheckpointerStop {
  /** False when stop() ended it; true when the worker failed or exited by itself. */
  unexpected: boolean;
  err?: unknown;
}

/** The sync settings the worker's connection runs with, as it reports them. */
export type CheckpointerSettings = Extract<CheckpointWorkerMessage, { type: 'ready' }>['settings'];

export type CheckpointRecord = Omit<
  Extract<CheckpointWorkerMessage, { type: 'checkpoint' }>,
  'type'
>;

export interface BackgroundCheckpointer {
  /** The pragmas the worker's connection runs before its first checkpoint. */
  readonly pragmas: readonly string[];
  /** The worker connection's own sync settings, once it has opened. */
  readonly ready: Promise<CheckpointerSettings>;
  /** How many checkpoints the worker has run so far. */
  readonly checkpoints: number;
  /** Resolves once, when the worker has stopped, with why. */
  readonly stopped: Promise<CheckpointerStop>;
  /**
   * Stops the worker after its current checkpoint and closes its connection. A worker inside a
   * native call (a disk that does not answer) cannot be ended before the call returns, and it
   * also holds up the process's own exit until then; closeDatabase bounds its wait for this.
   */
  stop(): Promise<void>;
}

/** The worker's file: TypeScript, run with tsx as its loader (checkpointWorker.ts). */
const WORKER_FILE = fileURLToPath(new URL('./checkpointWorker.ts', import.meta.url));

/**
 * Starts a checkpointer on `file`. `pragmas` are the main connection's sync settings, so the
 * worker's checkpoints are as durable as the main connection's own would have been; `pageSize`
 * is the database's, which the worker checks the wal-index header against.
 */
export function startBackgroundCheckpointer(
  file: string,
  opts: {
    pragmas: readonly string[];
    pageSize: number;
    onStopped: (stop: CheckpointerStop) => void;
    onCheckpoint?: (checkpoint: CheckpointRecord) => void;
    /** Tests and benchmarks only: smaller thresholds and a faster poll. */
    maxPages?: number;
    maxWaitMs?: number;
    pollMs?: number;
  },
): BackgroundCheckpointer {
  const data: CheckpointWorkerData = {
    checkpointer: true,
    file,
    pragmas: [...opts.pragmas],
    pageSize: opts.pageSize,
    maxPages: opts.maxPages ?? CHECKPOINT_PAGES,
    maxWaitMs: opts.maxWaitMs ?? CHECKPOINT_MAX_WAIT_MS,
    pollMs: opts.pollMs ?? POLL_MS,
    retryMs: RETRY_MS,
  };
  const worker = new Worker(WORKER_FILE, { workerData: data, execArgv: ['--import', 'tsx'] });
  // Not what keeps the process alive while it runs: the server's close stops it, and a CLI's
  // exit ends it (stop() refs it again until it has stopped).
  worker.unref();
  let stopping = false;
  let failure: unknown;
  let checkpoints = 0;
  let onReady: (settings: CheckpointerSettings) => void = () => undefined;
  const ready = new Promise<CheckpointerSettings>((resolve) => (onReady = resolve));
  worker.on('message', (message: CheckpointWorkerMessage) => {
    if (message.type === 'ready') onReady(message.settings);
    else {
      checkpoints += 1;
      opts.onCheckpoint?.({
        reason: message.reason,
        log: message.log,
        checkpointed: message.checkpointed,
        ms: message.ms,
      });
    }
  });
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
    ready,
    get checkpoints() {
      return checkpoints;
    },
    stopped,
    async stop() {
      if (!stopping) {
        stopping = true;
        // Unref'd, the worker would let a shutdown end before it had stopped: the awaited close
        // would never finish, nor the main connection's own close after it. While it stops, it
        // keeps the process alive.
        worker.ref();
        worker.postMessage('stop');
        // A worker stuck in JavaScript still ends; one inside a native call ends once it returns.
        setTimeout(() => void worker.terminate(), STOP_GRACE_MS).unref();
      }
      await stopped;
    },
  };
}
