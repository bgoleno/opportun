// The write gate (db/gate.ts) and withTransaction (db/client.ts): one connection, an async
// driver, and the sync driver's guarantee that nothing interleaves with a transaction
// (iteration 4 plan, Review Focus 1).
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  rawAll,
  rawGet,
  rawRun,
  runCount,
  lockScope,
  withTransaction,
  type Db,
  type DbHandle,
} from '../src/db/client';
import {
  configureGateWatchdog,
  onSlowTransaction,
  SLOW_TRANSACTION_MS,
  type GateHeld,
  type SlowTransaction,
  type WatchdogClock,
} from '../src/db/gate';
import { settings } from '../src/db/schema';
import { sql } from 'drizzle-orm';
import { sqliteOnly } from './db';
import { openTestDb } from './helpers';

let handle: DbHandle | undefined;
let closeHandle: (() => Promise<void>) | undefined;

// These tests hold transactions open across awaits on purpose (that is what the gate is
// for), which test/setup.ts would otherwise fail as I/O inside a transaction.
beforeEach(() => onSlowTransaction(() => undefined));

afterEach(async () => {
  await closeHandle?.();
  closeHandle = undefined;
  handle = undefined;
});

async function open(): Promise<Db> {
  // The run's dialect: the gate itself is SQLite's, the facade and scope tests run on both.
  const opened = await openTestDb();
  handle = opened.handle;
  closeHandle = opened.close;
  return handle.db;
}

/** The SQLite connection under the gate (SQLite-only tests). */
function sqliteOf(h: DbHandle | undefined) {
  if (h?.dialect !== 'sqlite') throw new Error('a SQLite-only test opened a non-SQLite handle');
  return h.sqlite;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Lets every queued microtask and a macrotask run. */
const tick = () => new Promise((r) => setTimeout(r, 5));

/**
 * A WatchdogClock the test drives by hand (issue #72), so "has the threshold been crossed" is
 * decided by this test rather than by how busy the machine happens to be. Only the watchdog's
 * own timer uses this; every other timer in the process, including the real database driver's,
 * is untouched, unlike globally faking time (tried and reverted: it also starves a real
 * Postgres connection's own internals of working timers and hangs the transaction outright).
 */
function fakeWatchdogClock(): { clock: WatchdogClock; advance: (ms: number) => void } {
  let now = 0;
  const timers: { at: number; cb: () => void }[] = [];
  return {
    clock: {
      now: () => now,
      setTimeout: (cb, ms) => {
        const entry = { at: now + ms, cb };
        timers.push(entry);
        return entry as unknown as NodeJS.Timeout;
      },
      clearTimeout: (timer) => {
        const i = timers.indexOf(timer as unknown as { at: number; cb: () => void });
        if (i !== -1) timers.splice(i, 1);
      },
    },
    advance: (ms) => {
      now += ms;
      for (const t of timers.filter((t) => t.at <= now).slice()) {
        const i = timers.indexOf(t);
        if (i !== -1) timers.splice(i, 1);
        t.cb();
      }
    },
  };
}

const put = (db: Db, key: string) =>
  db.insert(settings).values({ key, value: key, updatedAt: 0 }).run();
const keys = async (db: Db) =>
  (await db.select({ key: settings.key }).from(settings).all())
    .map((r) => r.key)
    .filter((k) => k.startsWith('t:'))
    .sort();

describe.runIf(sqliteOnly)('write gate', () => {
  it('holds a concurrent statement until the open transaction rolls back, and keeps it', async () => {
    const db = await open();
    const parked = deferred();
    const order: string[] = [];
    const a = withTransaction(db, async (tx) => {
      await tx.insert(settings).values({ key: 't:a', value: 1, updatedAt: 0 }).run();
      await parked.promise;
      throw new Error('A fails');
    });
    await tick();
    const b = put(db, 't:b').then(() => order.push('B written'));
    await tick();
    // B is not inside A's transaction: it has not run yet.
    expect(order).toEqual([]);
    expect(
      sqliteOf(handle).prepare("SELECT count(*) AS n FROM settings WHERE key = 't:b'").get(),
    ).toEqual({ n: 0 });
    order.push('A released');
    parked.resolve();
    await expect(a).rejects.toThrow('A fails');
    await b;
    expect(order).toEqual(['A released', 'B written']);
    expect(await keys(db)).toEqual(['t:b']);
  });

  it('runs a concurrent read only after the open transaction commits', async () => {
    const db = await open();
    const parked = deferred();
    const a = withTransaction(db, async (tx) => {
      await tx.insert(settings).values({ key: 't:a', value: 1, updatedAt: 0 }).run();
      await parked.promise;
      await tx.insert(settings).values({ key: 't:a2', value: 1, updatedAt: 0 }).run();
    });
    await tick();
    let seen: string[] | undefined;
    const b = keys(db).then((k) => (seen = k));
    await tick();
    expect(seen).toBeUndefined();
    parked.resolve();
    await a;
    await b;
    // Never a half-written transaction: both rows or none.
    expect(seen).toEqual(['t:a', 't:a2']);
  });

  it('runs two concurrent transactions strictly one after the other', async () => {
    const db = await open();
    const events: string[] = [];
    const body =
      (name: string) => async (tx: Parameters<Parameters<typeof withTransaction>[1]>[0]) => {
        events.push(`${name} enter`);
        await tx
          .insert(settings)
          .values({ key: `t:${name}`, value: 1, updatedAt: 0 })
          .run();
        await tick();
        await tx.select().from(settings).all();
        events.push(`${name} exit`);
      };
    await Promise.all([withTransaction(db, body('a')), withTransaction(db, body('b'))]);
    expect(events).toEqual(['a enter', 'a exit', 'b enter', 'b exit']);
    expect(await keys(db)).toEqual(['t:a', 't:b']);
  });

  it('runs a statement synchronously at call time when no transaction is open', async () => {
    const db = await open();
    const pending = put(db, 't:now');
    // No await yet: the row is already there, exactly as with the sync driver.
    expect(sqliteOf(handle).prepare("SELECT key FROM settings WHERE key = 't:now'").get()).toEqual({
      key: 't:now',
    });
    await pending;
  });

  it('releases the gate when the body throws', async () => {
    const db = await open();
    await expect(
      withTransaction(db, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await withTransaction(db, async (tx) => {
      await tx.insert(settings).values({ key: 't:after', value: 1, updatedAt: 0 }).run();
    });
    expect(await keys(db)).toEqual(['t:after']);
  });

  it('uses a savepoint for a nested transaction; its rollback leaves the outer one usable', async () => {
    const db = await open();
    await withTransaction(db, async (tx) => {
      await tx.insert(settings).values({ key: 't:outer1', value: 1, updatedAt: 0 }).run();
      await expect(
        withTransaction(tx, async (inner) => {
          await inner.insert(settings).values({ key: 't:inner', value: 1, updatedAt: 0 }).run();
          throw new Error('inner fails');
        }),
      ).rejects.toThrow('inner fails');
      await tx.insert(settings).values({ key: 't:outer2', value: 1, updatedAt: 0 }).run();
    });
    expect(await keys(db)).toEqual(['t:outer1', 't:outer2']);
  });

  it('refuses the root database inside its own transaction: the body must use its tx', async () => {
    const db = await open();
    await withTransaction(db, async (tx) => {
      // On a Postgres pool these would run outside the transaction; here they are refused.
      expect(() => db.select().from(settings)).toThrow(/use its tx/);
      expect(() => db.insert(settings)).toThrow(/use its tx/);
      await expect(withTransaction(db, async () => undefined)).rejects.toThrow(/pass its tx/);
      await tx.insert(settings).values({ key: 't:outer', value: 1, updatedAt: 0 }).run();
    });
    expect(await keys(db)).toEqual(['t:outer']);
  });

  it('reports a transaction that awaits outside the database, and only that one', async () => {
    const db = await open();
    const slow: SlowTransaction[] = [];
    onSlowTransaction((s) => slow.push(s));
    // Database work only, however many statements: the event loop never turns.
    await withTransaction(db, async (tx) => {
      for (let i = 0; i < 200; i++) {
        await tx
          .insert(settings)
          .values({ key: `t:${i}`, value: i, updatedAt: 0 })
          .run();
      }
    });
    expect(slow.filter((s) => s.awaitedOutside)).toEqual([]);
    // A timer (or fetch, file, argon2) inside the transaction is caught however short it is.
    await withTransaction(db, async () => {
      await new Promise((r) => setTimeout(r, 1));
    });
    const outside = slow.filter((s) => s.awaitedOutside);
    expect(outside).toHaveLength(1);
    expect(outside[0]!.stack).toContain('dbGate.test.ts');
    // Past the time budget is reported too (setup.ts only warns on that alone).
    await withTransaction(db, async () => {
      await new Promise((r) => setTimeout(r, SLOW_TRANSACTION_MS + 30));
    });
    expect(slow.at(-1)!.durationMs).toBeGreaterThan(SLOW_TRANSACTION_MS);
  });
});

describe('raw SQL and counts', () => {
  it('returns object rows, the first row, and changes', async () => {
    const db = await open();
    await put(db, 't:1');
    await put(db, 't:2');
    expect(
      await rawAll<{ key: string }>(
        db,
        sql`SELECT key FROM settings WHERE key LIKE 't:%' ORDER BY key`,
      ),
    ).toEqual([{ key: 't:1' }, { key: 't:2' }]);
    expect(
      await rawGet<{ n: number }>(db, sql`SELECT count(*) AS n FROM settings WHERE key LIKE 't:%'`),
    ).toEqual({ n: 2 });
    expect(await rawGet(db, sql`SELECT key FROM settings WHERE key = 'none'`)).toBeUndefined();
    expect(await rawRun(db, sql`UPDATE settings SET updated_at = 1 WHERE key LIKE 't:%'`)).toEqual({
      changes: 2,
    });
    expect(await runCount(db.delete(settings).where(eq(settings.key, 't:1')))).toBe(1);
    expect(await runCount(db.delete(settings).where(eq(settings.key, 't:1')))).toBe(0);
  });

  it.runIf(sqliteOnly)('waits for the gate like builder statements', async () => {
    const db = await open();
    const parked = deferred();
    const a = withTransaction(db, async (tx) => {
      await tx.insert(settings).values({ key: 't:a', value: 1, updatedAt: 0 }).run();
      await parked.promise;
    });
    await tick();
    let n: number | undefined;
    const b = rawGet<{ n: number }>(
      db,
      sql`SELECT count(*) AS n FROM settings WHERE key LIKE 't:%'`,
    ).then((r) => (n = r?.n));
    await tick();
    expect(n).toBeUndefined();
    parked.resolve();
    await a;
    await b;
    expect(n).toBe(1);
  });
});

describe('transaction scopes', () => {
  it('takes a scope lock only inside a transaction', async () => {
    const db = await open();
    await expect(lockScope(db, 'user:u1')).rejects.toThrow(/outside a transaction/);
    await withTransaction(db, async (tx) => {
      await lockScope(tx, 'user:u1');
      // Never the root handle, even inside its own transaction.
      await expect(lockScope(db, 'user:u1')).rejects.toThrow(/outside a transaction/);
      await tx.insert(settings).values({ key: 't:scoped', value: 1, updatedAt: 0 }).run();
    });
    await withTransaction(db, async (tx) => put(tx as Db, 't:scoped2'), { scope: 'registration' });
    expect(await keys(db)).toEqual(['t:scoped', 't:scoped2']);
  });
});

describe('the root handle cannot open a transaction (review fix 2)', () => {
  it('refuses db.transaction in every environment: transactions go through withTransaction', async () => {
    const db = await open();
    // The reviewer's probe 3: a transaction opened on the root handle bypasses the gate, so
    // another request's statement would land inside it and roll back with it.
    // eslint-disable-next-line no-restricted-syntax -- asserting the runtime refusal
    expect(() => db.transaction(async () => undefined)).toThrow(/withTransaction/);
    // Opened as if NOT a test run (issue #292): openTestDb's isTestRun override reaches
    // guardRoot directly, rather than mutating process.env.VITEST/NODE_ENV, which vitest's
    // threads pool shares across every test file running in the same worker and could
    // silently flip for one of them mid-await.
    const opened = await openTestDb({ isTestRun: false });
    const prod = opened.handle;
    try {
      // eslint-disable-next-line no-restricted-syntax -- asserting the runtime refusal
      expect(() => prod.db.transaction(async () => undefined)).toThrow(/withTransaction/);
      // withTransaction still works there.
      await withTransaction(
        prod.db,
        async (tx) => {
          await tx.insert(settings).values({ key: 't:prod', value: 1, updatedAt: 0 }).run();
        },
        { isTestRun: false },
      );
    } finally {
      await opened.close();
    }
  });
});

describe('production watchdog (review fix 5)', () => {
  it('warns once, naming the holder, when a transaction holds the gate too long outside tests', async () => {
    // Issue #72: this told "quick" from "slow" by racing a real transaction against a tight
    // 40 ms threshold. Under full-suite CI contention the event loop itself can be starved for
    // tens of milliseconds between acquiring the gate and releasing it, so a bare synchronous
    // insert — nothing slow about the work itself — was once observed to read as 40 ms, warning
    // when it should not have: the test was measuring how busy the machine was, not what the
    // watchdog did.
    //
    // Globally faking time was tried and reverted: vi.useFakeTimers({toFake: [...]}) also stops
    // a real Postgres connection's own internals from getting working timers, and the test hung
    // outright on that leg (confirmed by CI, not assumed). The fix instead uses the seam
    // db/gate.ts now exposes for exactly this (WatchdogClock, configureGateWatchdog's `clock`
    // option): only the watchdog's own setTimeout and performance.now() are swapped for a fake
    // one this test drives by hand. Every other timer in the process, including the database
    // driver's, is untouched, so there is no real-time race left to lose, on either dialect.
    const held: GateHeld[] = [];
    const opened = await openTestDb();
    const prod = opened.handle;
    const { clock, advance } = fakeWatchdogClock();
    // Each withTransaction call below passes isTestRun: false (issue #292) so the watchdog
    // arms as it would in production, rather than mutating process.env.VITEST/NODE_ENV: that
    // mutation would be visible to any other test file vitest's threads pool schedules onto
    // this same worker while an await here is pending.
    try {
      configureGateWatchdog({ ms: 40, report: (h) => held.push(h), clock });
      // Quick: releases without the fake clock ever advancing, so the watchdog's timer is
      // armed and disarmed but never fires. Nothing races it: there is no real deadline here.
      await withTransaction(
        prod.db,
        async (tx) => {
          await tx.insert(settings).values({ key: 't:quick', value: 1, updatedAt: 0 }).run();
        },
        { isTestRun: false },
      );
      expect(held).toHaveLength(0);
      // Held past the threshold: one warning, not one per tick. The body's own delay is real
      // but trivial and plays no part in the decision — advancing the fake clock past 40 ms,
      // while the transaction is still open, is what crosses the threshold, deterministically.
      const slow = withTransaction(
        prod.db,
        async () => {
          await tick();
        },
        { label: 'slow.import', isTestRun: false },
      );
      await tick(); // the gate is acquired and the watchdog armed by now (pure microtask work)
      advance(50);
      await slow;
      expect(held).toHaveLength(1);
      expect(held[0]!.label).toBe('slow.import');
      expect(held[0]!.heldMs).toBeGreaterThanOrEqual(40);
      // Without a label the caller's frame names the holder.
      const third = withTransaction(
        prod.db,
        async () => {
          await tick();
        },
        { isTestRun: false },
      );
      await tick();
      advance(50);
      await third;
      expect(held).toHaveLength(2);
      expect(held[1]!.label).toContain('dbGate.test.ts');
    } finally {
      configureGateWatchdog({});
      await opened.close();
    }
  });
});
