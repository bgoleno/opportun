// Deterministic interleaving for racing tests (iteration 4 Task 5). `holdAt(point, n)` makes
// the first n callers that reach src/lib/racePoints `point` wait for one another, then lets
// them all go at once: every caller has done its reads and checks, none has written. A
// caller that never arrives fails the test after a timeout instead of hanging it.
import { afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { writeGateOf } from '../src/db/client';
import { onSlowTransaction } from '../src/db/gate';
import { setRaceHook } from '../src/lib/racePoints';
import { queryOne, type HasDb } from './db';

const ARRIVAL_TIMEOUT_MS = 3000;

export interface Barrier {
  /** How many callers reached the point (the test asserts it saw the interleaving). */
  arrived(): number;
}

afterEach(() => {
  setRaceHook(undefined);
});

/** Holds the first `parties` callers of `point` until all have arrived. */
export function holdAt(point: string, parties = 2): Barrier {
  let count = 0;
  let open!: () => void;
  let fail!: (err: Error) => void;
  const allHere = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  let timer: NodeJS.Timeout | undefined;
  setRaceHook(async (reached) => {
    if (reached !== point || count >= parties) return;
    count += 1;
    if (count === 1) {
      timer = setTimeout(
        () => fail(new Error(`only ${count} of ${parties} callers reached race point ${point}`)),
        ARRIVAL_TIMEOUT_MS,
      );
    }
    if (count === parties) {
      clearTimeout(timer);
      open();
    }
    await allHere;
  });
  return { arrived: () => count };
}

export interface Pause {
  /** Resolves when the first caller reaches the point (it is then parked there). */
  reached: Promise<void>;
  /** Lets the parked caller continue. */
  release(): void;
  /** How many callers reached the point so far (the parked one included). */
  arrived(): number;
}

/**
 * Parks the first caller of `point` until release(), so a test can run a whole competing
 * request in between: a fixed interleaving of "A checked, B ran start to finish, A writes".
 */
export function pauseAt(point: string): Pause {
  let arrive!: () => void;
  let go!: () => void;
  let missing!: (err: Error) => void;
  const reached = new Promise<void>((resolve, reject) => {
    arrive = resolve;
    missing = reject;
  });
  const timer = setTimeout(
    () => missing(new Error(`no caller reached race point ${point}`)),
    ARRIVAL_TIMEOUT_MS,
  );
  const gate = new Promise<void>((r) => (go = r));
  let taken = false;
  let count = 0;
  setRaceHook(async (p) => {
    if (p !== point) return;
    count += 1;
    if (taken) return;
    taken = true;
    clearTimeout(timer);
    arrive();
    await gate;
  });
  return { reached, release: () => go(), arrived: () => count };
}

/** How often the held-apart oracle looks at the second caller. */
const POLL_MS = 10;

/**
 * How long the oracle looks before giving up. Generous on purpose and not a timing oracle:
 * no outcome is inferred from it running out. On correct code the second caller is seen
 * waiting within a few polls, however loaded the host; the bound only ends a test in which
 * nothing is ever seen (a harness bug, or a caller held somewhere other than a lock), and it
 * stays well inside the 30 s test timeout so that failure names its cause.
 */
const OBSERVE_DEADLINE_MS = 10_000;

/** What the oracle saw the second caller do while the first was parked. */
export type Seen = 'waiting' | 'arrived' | 'settled';

const WAITING_ADVISORY_LOCKS = sql`SELECT count(*)::int AS n FROM pg_locks
  WHERE locktype = 'advisory' AND NOT granted
    AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;

/**
 * Callers held back right now. SQLite: those waiting at the app's write gate (a transaction
 * queued at BEGIN, or a statement waiting for the gate to be free). Postgres: ungranted
 * advisory locks (lockScope) in this test's own database, read through the app's pool outside
 * any transaction; every test app has a database of its own, so no other test's locks count.
 */
async function waitingCallers(app: HasDb): Promise<number> {
  const gate = writeGateOf(app.db);
  if (gate !== undefined) return gate.waiting();
  return (await queryOne<{ n: number }>(app, WAITING_ADVISORY_LOCKS))?.n ?? 0;
}

/**
 * Polls until `caller` is observed doing one of three things, and says which: it reached
 * `pause`'s point too (a second arrival, so nothing held it back); it settled; or it is waiting,
 * exactly one caller held at the gate or at an advisory lock. Throws if none is seen within
 * OBSERVE_DEADLINE_MS. https://github.com/bgoleno/opportun/issues/62 replaced a fixed window
 * here: a caller slow to reach its lock under load used to pass for one that was held.
 */
export async function settledOrWaiting(
  app: HasDb,
  caller: Promise<unknown>,
  pause?: Pause,
): Promise<Seen> {
  let settled = false;
  const done = () => {
    settled = true;
  };
  void caller.then(done, done);
  const deadline = performance.now() + OBSERVE_DEADLINE_MS;
  let last = 0;
  for (;;) {
    // A second arrival first: a caller that got past its lock and then finished did both.
    if (pause !== undefined && pause.arrived() > 1) return 'arrived';
    if (settled) return 'settled';
    last = await waitingCallers(app);
    if (last === 1 && !settled) return 'waiting';
    if (performance.now() > deadline) {
      throw new Error(
        `never observed the caller waiting, arriving or settling within ${String(OBSERVE_DEADLINE_MS)} ms (${String(last)} waiting at the last look)`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/**
 * Scope-lock oracle (iteration 4 Task 13, made positive by
 * https://github.com/bgoleno/opportun/issues/62): `first` runs until it parks at the
 * in-transaction race point `point` (a `.locked` point, after its scope lock); then `second`
 * starts, and the test passes only if `second` is OBSERVED waiting (settledOrWaiting): on
 * Postgres its advisory scope lock ungranted in pg_locks, on SQLite its request queued at the
 * write gate. A second arrival at the point, or `second` finishing, fails at once; neither
 * seen within the deadline fails too. Then `first` is released and both results are returned
 * for the caller's exactly-one assertions. The parked transaction is open across event-loop
 * turns on purpose, so the "awaited outside the database" check is silenced for the calling test.
 */
export async function heldApart<A, B>(
  app: HasDb,
  point: string,
  first: () => Promise<A>,
  second: () => Promise<B>,
): Promise<[A, B]> {
  onSlowTransaction(() => undefined);
  const pause = pauseAt(point);
  const a = first();
  // A failure of `first` before it parks must surface, not hang on `reached`.
  await Promise.race([pause.reached, a.then(() => undefined)]);
  if (pause.arrived() === 0) throw new Error(`the first caller finished without reaching ${point}`);
  const b = second();
  let seen: Seen;
  try {
    seen = await settledOrWaiting(app, b, pause);
  } catch (err) {
    pause.release();
    await Promise.allSettled([a, b]);
    throw err;
  }
  pause.release();
  if (seen !== 'waiting') {
    await Promise.allSettled([a, b]);
    throw new Error(
      `the second caller ${seen === 'settled' ? 'finished' : 'got past its lock'} while the first held the scope at ${point}`,
    );
  }
  return await Promise.all([a, b]);
}
