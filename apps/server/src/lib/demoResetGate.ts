// The demo reset's gate (https://github.com/bgoleno/opportun/issues/618, criterion 4; tl's design
// on #618). The nightly reset deletes the shared demo accounts and reseeds them under the same
// pinned ids, so a write that began before it (a request authenticated a moment earlier, a job
// claimed before it) would land in the fresh account. This gate keeps the two apart:
//   - every authenticated request on a demo server holds the shared side, from before its session
//     or token is looked up until its response is closed (app.ts, demoResetHold);
//   - a job of a shared demo account holds it around its run (jobs/runner.ts), and once it holds
//     it the runner checks the job's row is still there (the reset deletes those users' jobs);
//   - the reset holds the exclusive side around seedDemo (jobs/demoReset.ts).
// So a request or a job either finishes before the reset starts, or waits for it and then finds
// its session, token or row gone. Writer-preferring: once the reset waits, new holders wait behind
// it, or a steady stream of visitors would hold it off. Its wait is bounded (EXCLUSIVE_TIMEOUT_MS):
// on timeout the reset fails, and retries later, rather than let an old write land.
//
// In process: one server process per database, as docs/install.md requires (one instance; the job
// runner and the write gate assume it too). Off the demo there is no gate, and nothing waits.

/** How long the reset waits for the holders before it gives up (and retries later, tl). */
export const EXCLUSIVE_TIMEOUT_MS = 60_000;

export class DemoResetGateTimeout extends Error {
  constructor() {
    super('demo reset: requests or jobs still in flight after the wait; not reset');
  }
}

/**
 * A hold on the shared side. release() is idempotent. retain() adds a reference to the same hold,
 * never a new acquire (which could wait behind a waiting reset that waits for this hold): the
 * hold is given back when every reference is released.
 */
export interface Hold {
  release(): void;
  retain(): Hold;
}

export class DemoResetGate {
  private holders = 0;
  private writing = false;
  /** Exclusive acquirers waiting behind the one in, in order. */
  private readonly writers: (() => void)[] = [];
  /** Shared acquirers waiting behind a writer. */
  private readonly readers: (() => void)[] = [];
  /** Resolves the current exclusive waiter when the last holder leaves. */
  private drained: (() => void) | null = null;

  /** Takes the shared side; waits while the reset runs or waits. */
  async shared(): Promise<Hold> {
    if (this.writing) {
      await new Promise<void>((resolve) => this.readers.push(resolve));
    }
    this.holders += 1;
    let refs = 0;
    const leave = () => {
      this.holders -= 1;
      if (this.holders === 0) this.drained?.();
    };
    const reference = (): Hold => {
      refs += 1;
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          refs -= 1;
          if (refs === 0) leave();
        },
        retain: reference,
      };
    };
    return reference();
  }

  /**
   * Takes the exclusive side: waits for every holder to leave, then runs `fn` with no holder in.
   * New holders wait from the moment this is called. Throws DemoResetGateTimeout, running
   * nothing, when the holders are not all gone in `timeoutMs`.
   */
  async exclusive<T>(fn: () => Promise<T>, timeoutMs = EXCLUSIVE_TIMEOUT_MS): Promise<T> {
    // One writer at a time: a second waits for the first, which hands the gate on to it still
    // closed (below), so no holder slips in between the two.
    if (this.writing) await new Promise<void>((resolve) => this.writers.push(resolve));
    this.writing = true;
    try {
      if (this.holders > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const ok = await Promise.race([
          new Promise<true>((resolve) => {
            this.drained = () => resolve(true);
          }),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
          }),
        ]);
        clearTimeout(timer);
        this.drained = null;
        if (!ok) throw new DemoResetGateTimeout();
      }
      return await fn();
    } finally {
      const next = this.writers.shift();
      if (next !== undefined) {
        next();
      } else {
        this.writing = false;
        for (const wake of this.readers.splice(0)) wake();
      }
    }
  }

  /** For tests and the log: how many hold the shared side now. */
  get held(): number {
    return this.holders;
  }
}
