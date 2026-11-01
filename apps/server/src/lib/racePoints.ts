// Race points (iteration 4 Task 5): named spots just before an atomic step that racing tests
// use to hold concurrent callers until all of them have arrived, so the worst interleaving
// (every caller past its checks, none past its write) is produced deterministically rather
// than by luck. A no-op unless a test installs a hook.
//
// Points named `<name>.locked` sit INSIDE a transaction, after its scope lock (lockScope) and
// its check, just before the write (iteration 4 Task 13), or, where the race is between two
// reads of the check itself, between those reads (`oauth.login.locked`,
// https://github.com/bgoleno/opportun/issues/56). They exist for the Postgres leg,
// where only the advisory scope lock keeps two open transactions apart: a test parks one
// caller there (test/race.ts pauseAt, never holdAt: a barrier would wait for a caller the lock
// is holding back) and asserts the other never gets past its own lock meanwhile. The same
// test holds on SQLite, where the write gate keeps the second transaction from starting.
// The wait is observed, not timed (test/race.ts heldApart and settledOrWaiting,
// https://github.com/bgoleno/opportun/issues/62): on Postgres the second caller's advisory
// lock shows as ungranted in pg_locks, on SQLite its request waits at the write gate
// (WriteGate.waiting).

type RaceHook = (point: string) => Promise<void> | void;

let hook: RaceHook | undefined;

/** Test-only: install (or clear) the hook every race point calls. */
export function setRaceHook(next: RaceHook | undefined): void {
  hook = next;
}

/** Marks a race point; resolves at once in production. */
export async function racePoint(point: string): Promise<void> {
  if (hook !== undefined) await hook(point);
}
