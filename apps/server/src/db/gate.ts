// The SQLite write gate (ADR-4 amended, iteration 4 Task 2). One better-sqlite3 connection
// serves every request through drizzle's async sqlite-proxy driver. While a transaction is
// open and awaiting, a statement from another request would otherwise run on the shared
// connection inside that transaction and commit or roll back with it. The gate restores the
// sync driver's guarantee that nothing interleaves with a transaction: a transaction holds
// the gate from BEGIN to COMMIT/ROLLBACK, and every statement issued from any other async
// context waits until the gate is free. The holder is identified through AsyncLocalStorage,
// so statements issued by the transaction body (however deeply nested) pass straight through.
import { AsyncLocalStorage } from 'node:async_hooks';

export type Release = () => void;

/** The transaction token of the current async context, shared by every gate. */
const context = new AsyncLocalStorage<symbol>();

export class WriteGate {
  #holder: symbol | undefined;
  readonly #queue: { token: symbol; resolve: () => void }[] = [];
  #idle: (() => void)[] = [];

  /** The token of the transaction holding the gate, if any. */
  holder(): symbol | undefined {
    return this.#holder;
  }

  /** The transaction token of the calling async context (undefined outside a transaction). */
  currentToken(): symbol | undefined {
    return context.getStore();
  }

  /**
   * Waits for exclusive ownership (FIFO among transactions). The returned release hands the
   * gate to the next queued transaction, or frees it and wakes waiting statements.
   */
  async acquire(token: symbol): Promise<Release> {
    if (this.#holder !== undefined) {
      await new Promise<void>((resolve) => this.#queue.push({ token, resolve }));
    }
    this.#holder = token;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#queue.shift();
      if (next !== undefined) {
        this.#holder = next.token;
        next.resolve();
        return;
      }
      this.#holder = undefined;
      const waiters = this.#idle;
      this.#idle = [];
      for (const wake of waiters) wake();
    };
  }

  /** Runs `fn` with `token` as the current context's transaction token. */
  run<T>(token: symbol, fn: () => T): T {
    return context.run(token, fn);
  }

  /** True when a statement from the calling context must wait for another transaction. */
  mustWait(): boolean {
    return this.#holder !== undefined && this.#holder !== context.getStore();
  }

  /**
   * Resolves once a statement from the calling context may run: the gate is free or held by
   * the caller's own transaction. Callers check mustWait() first so the free path stays
   * synchronous (statement order is then exactly the call order, as with the sync driver).
   */
  async idleFor(token: symbol | undefined = context.getStore()): Promise<void> {
    while (this.#holder !== undefined && this.#holder !== token) {
      await new Promise<void>((resolve) => this.#idle.push(resolve));
    }
  }
}

/** A transaction that held the gate longer than this draws a warning in tests. */
export const SLOW_TRANSACTION_MS = 250;

export interface SlowTransaction {
  durationMs: number;
  /**
   * True when the body awaited something outside the database (fetch, files, argon2, a
   * timer): the event loop turned while the gate was held. A database-only body never lets
   * it turn, because every statement resolves at once under the gate. This is the rule the
   * guard enforces (no external I/O inside a transaction), and it does not depend on load.
   */
  awaitedOutside: boolean;
  /** Stack of withTransaction's caller. */
  stack: string;
}

let slowReporter: (slow: SlowTransaction) => void = (slow) => {
  console.warn(
    `slow transaction: held the database write gate for ${slow.durationMs} ms${slow.awaitedOutside ? ' while awaiting something outside the database' : ''} (budget ${SLOW_TRANSACTION_MS} ms)\n${slow.stack}`,
  );
};

/** Test hook: test/setup.ts fails the running test on a transaction that awaited outside. */
export function onSlowTransaction(reporter: (slow: SlowTransaction) => void): void {
  slowReporter = reporter;
}

export function reportSlowTransaction(slow: SlowTransaction): void {
  slowReporter(slow);
}

/** Outside tests, a transaction holding the gate this long draws one warning. */
export const GATE_WATCHDOG_MS = 5000;

export interface GateHeld {
  /** TransactionOptions.label, or the frame that called withTransaction. */
  label: string;
  heldMs: number;
}

let watchdogMs = GATE_WATCHDOG_MS;
let watchdogReport: (held: GateHeld) => void = (held) => {
  console.warn(
    `database write gate held for ${held.heldMs} ms by ${held.label}: every other request is waiting`,
  );
};

/**
 * What armGateWatchdog schedules against: real setTimeout/performance.now() in production.
 * Swappable (issue #72) so a test can make "has the threshold been crossed" deterministic
 * without faking time process-wide, which would also starve a real async database driver's
 * own internals of working timers (observed: an open Postgres transaction hung outright under
 * a global fake-timer install). Swapping only this one seam leaves every other timer, in this
 * process and in the driver, running on the real clock.
 */
export interface WatchdogClock {
  now(): number;
  setTimeout(cb: () => void, ms: number): NodeJS.Timeout;
  clearTimeout(timer: NodeJS.Timeout): void;
}

const realClock: WatchdogClock = {
  now: () => performance.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};

let watchdogClock = realClock;

/** Wires the warning (buildApp: the app logger); tests may also shorten the threshold or swap the clock. */
export function configureGateWatchdog(opts: {
  ms?: number;
  report?: (held: GateHeld) => void;
  clock?: WatchdogClock;
}): void {
  watchdogMs = opts.ms ?? GATE_WATCHDOG_MS;
  if (opts.report !== undefined) watchdogReport = opts.report;
  watchdogClock = opts.clock ?? realClock;
}

/**
 * Arms the production watchdog for one transaction: fires at most once (one warning per
 * incident); the returned function disarms it at release.
 */
export function armGateWatchdog(label: () => string): () => void {
  const started = watchdogClock.now();
  const timer = watchdogClock.setTimeout(() => {
    watchdogReport({ label: label(), heldMs: Math.round(watchdogClock.now() - started) });
  }, watchdogMs);
  timer.unref?.();
  return () => watchdogClock.clearTimeout(timer);
}
