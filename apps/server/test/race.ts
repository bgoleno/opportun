// Deterministic interleaving for racing tests (iteration 4 Task 5). `holdAt(point, n)` makes
// the first n callers that reach src/lib/racePoints `point` wait for one another, then lets
// them all go at once: every caller has done its reads and checks, none has written. A
// caller that never arrives fails the test after a timeout instead of hanging it.
import { afterEach } from 'vitest';
import { onSlowTransaction } from '../src/db/gate';
import { setRaceHook } from '../src/lib/racePoints';

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

/** How long the second caller gets to (wrongly) pass its scope lock while the first is parked. */
const HELD_APART_MS = 200;

/**
 * Scope-lock oracle (iteration 4 Task 13): `first` runs until it parks at the in-transaction
 * race point `point` (a `.locked` point: after its scope lock and check, before its write);
 * then `second` starts and gets HELD_APART_MS to reach the same point. It must not: on
 * Postgres the advisory scope lock holds it at lockScope, on SQLite the write gate holds it
 * at BEGIN. Then `first` is released and both results are returned for the caller's
 * exactly-one assertions. The parked transaction is open across event-loop turns on purpose,
 * so the "awaited outside the database" check is silenced for the calling test.
 */
export async function heldApart<A, B>(
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
  let settled = false;
  const b = second().finally(() => (settled = true));
  await new Promise((r) => setTimeout(r, HELD_APART_MS));
  const passed = pause.arrived();
  const early = settled;
  pause.release();
  const results = await Promise.all([a, b]);
  if (passed !== 1 || early) {
    throw new Error(
      `the second caller ${early ? 'finished' : 'reached the locked point'} while the first held the scope at ${point}`,
    );
  }
  return results;
}
