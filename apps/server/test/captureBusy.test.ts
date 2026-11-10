// One user's captures waiting on their ingest lock must never leave other users without a
// database connection, and a capture that cannot go on gets a clear refusal
// (https://github.com/bgoleno/opportun/issues/309; tl's design on
// https://github.com/bgoleno/opportun/issues/309#issuecomment-6765588508). A capture waits for
// the user's one capture slot in memory, holding no connection, and on Postgres waits for the
// lock itself for a bounded time. Either wait running out is 503 capture_busy with retry-after.
// The provider is mocked and every posting is made up.
import { AiUnavailableError, runStructured } from '@opportun/ai';
import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostgresConfig } from '../src/config';
import { lockScope, rawGet, withTransaction } from '../src/db/client';
import { onSlowTransaction } from '../src/db/gate';
import { discoveryRuns, jobs, opportunities } from '../src/db/schema';
import { POSTING_RECONCILE_KIND } from '../src/jobs/discoveryKinds';
import { CAPTURE_SLOT, withCaptureSlot } from '../src/lib/captureLimit';
import { HttpError } from '../src/lib/errors';
import { setRaceHook } from '../src/lib/racePoints';
import { ingestScope } from '../src/repos/discovery';
import { transitionOpportunity } from '../src/repos/opportunities';
import { useApi } from './api';
import { queryOne, testDialect } from './db';
import { JOB } from './fixtures/capture/pages';
import type { TestClient } from './isolation';
import { pauseAt } from './race';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const PASSWORD = 'correct horse battery';
const boot = useApi();

const extracted = (n: number) => ({
  companyName: 'Initech',
  title: `Platform Engineer ${n}`,
  location: 'Austin, TX',
  remote: 'hybrid' as const,
  compNote: null,
  descriptionMd: 'Own the payments platform.',
  postingUrl: `https://careers.initech.example/jobs/${n}`,
});

beforeEach(() => {
  vi.mocked(runStructured).mockReset();
  // The web capture's extraction names the posting from the pasted text; the extension's
  // refinement has no key, so its deterministic reading stands.
  vi.mocked(runStructured).mockImplementation(async (_deps, task, opts) => {
    if (task === 'capture.extract') {
      const n = Number(/Posting (\d+)/.exec(opts.prompt + opts.system)?.[1] ?? 0);
      return extracted(n) as never;
    }
    throw new AiUnavailableError('no_key');
  });
});

const paste = (c: TestClient, n: number) =>
  c.request({
    method: 'POST',
    url: '/api/v1/capture',
    payload: { text: `Posting ${n}: Platform Engineer at Initech. Own the payments platform.` },
  });

async function token(c: TestClient): Promise<string> {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/device-tokens',
    payload: { name: 'Browser extension', scopes: ['capture:push'], password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { token: string }).token;
}

const push = (app: FastifyInstance, bearer: string) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/connector/capture',
    headers: { authorization: `Bearer ${bearer}` },
    payload: JOB,
  });

/** A 503 capture_busy with a retry-after, as both clients read it. */
function expectBusy(res: { statusCode: number; body: string; headers: Record<string, unknown> }) {
  expect(res.statusCode, res.body).toBe(503);
  expect(JSON.parse(res.body)).toEqual({ error: { code: 'capture_busy' } });
  expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
}

describe('#309: the per-user capture slot', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('two captures in a row from one user both go through', async () => {
    const { a } = await boot();
    expect((await paste(a, 1)).statusCode).toBe(201);
    expect((await paste(a, 2)).statusCode).toBe(201);
  });

  it('two captures at once from one user both go through: the second waits its turn', async () => {
    const { a } = await boot();
    const [one, two] = await Promise.all([paste(a, 1), paste(a, 2)]);
    expect([one.statusCode, two.statusCode]).toEqual([201, 201]);
  });

  // https://github.com/bgoleno/opportun/issues/324 (qa and tl on #318). A lock wait that runs out is
  // Postgres's 55P03; here a race hook throws one where the lock is held, so this runs on both
  // dialects. The Postgres block below has the real lock held from outside.
  describe('what a refusal leaves behind', () => {
    const lockTimeout = () =>
      Object.assign(new Error('canceling statement due to lock timeout'), {
        code: '55P03',
        severity: 'ERROR',
      });
    const failAt = (point: string, err: () => Error) =>
      setRaceHook(async (reached) => {
        if (reached === point) throw err();
      });
    const runsOf = (app: FastifyInstance, c: TestClient) =>
      app.db.select().from(discoveryRuns).where(eq(discoveryRuns.userId, c.userId)).all();

    it("a web capture refused at its lock: its run says so in the dialog's words", async () => {
      const { app, a } = await boot();
      failAt('discovery.ingest.locked', lockTimeout);
      expectBusy(await paste(a, 1));
      const runs = await runsOf(app, a);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.finishedAt).not.toBeNull();
      expect(runs[0]!.error).toBe(
        'Not saved: another capture of yours was still being saved. Capture it again in a few seconds.',
      );
    });

    it('any other error: the run keeps the error as it was', async () => {
      const { app, a } = await boot();
      failAt('discovery.ingest.locked', () => new Error('the store broke'));
      const res = await paste(a, 1);
      expect(res.statusCode, res.body).toBe(500);
      const runs = await runsOf(app, a);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.error).toBe('Error: the store broke');
    });

    /** A job captured, then dismissed: capturing it again moves it back to interested (advance). */
    async function capturedThenDismissed(app: FastifyInstance, c: TestClient, bearer: string) {
      const first = await push(app, bearer);
      expect(first.statusCode, first.body).toBe(201);
      const { opportunityId } = first.json<{ opportunityId: string }>();
      await transitionOpportunity(app.db, { userId: c.userId, isAdmin: false }, opportunityId, {
        to: 'dismissed',
      });
      return opportunityId;
    }

    it('a lock timeout in the stage move: the capture answers as saved, and is reconciled', async () => {
      const { app, a } = await boot();
      const bearer = await token(a);
      const id = await capturedThenDismissed(app, a, bearer);
      failAt('captureResolve.advance.locked', lockTimeout);
      const res = await push(app, bearer);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ opportunityId: id, stage: null });
    });

    // tl's and sec's point on #318: only a lock timeout is answered as saved. Passes on the code as
    // it is; it fails if the stage move's catch swallows every error.
    it('any other error in the stage move still fails the capture', async () => {
      const { app, a } = await boot();
      const bearer = await token(a);
      await capturedThenDismissed(app, a, bearer);
      failAt('captureResolve.advance.locked', () => new Error('the stage move broke'));
      const res = await push(app, bearer);
      expect(res.statusCode, res.body).toBe(500);
    });
  });

  describe('withCaptureSlot', () => {
    const fakeDb = {} as never;

    it('releases the slot when the locked call throws', async () => {
      await expect(
        withCaptureSlot(fakeDb, 'user-1', async () => {
          throw new Error('the locked call failed');
        }),
      ).rejects.toThrow('the locked call failed');
      // Free at once: no wait, no refusal.
      vi.useFakeTimers();
      await expect(withCaptureSlot(fakeDb, 'user-1', async () => 'ran')).resolves.toBe('ran');
    });

    it('hands the slot to waiters in turn, and refuses one that waits too long', async () => {
      vi.useFakeTimers();
      let finishFirst!: () => void;
      const order: string[] = [];
      const first = withCaptureSlot(fakeDb, 'user-2', async () => {
        await new Promise<void>((r) => (finishFirst = r));
        order.push('first');
      });
      const second = withCaptureSlot(fakeDb, 'user-2', async () => void order.push('second'));
      const third = withCaptureSlot(fakeDb, 'user-2', async () => void order.push('third'));
      await vi.advanceTimersByTimeAsync(CAPTURE_SLOT.waitMs - 1);
      finishFirst();
      await first;
      await second;
      await third;
      expect(order).toEqual(['first', 'second', 'third']);

      let finishHolder!: () => void;
      const holder = withCaptureSlot(
        fakeDb,
        'user-2',
        () => new Promise<void>((r) => (finishHolder = r)),
      );
      const late = withCaptureSlot(fakeDb, 'user-2', async () => 'never');
      const refused = late.catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(CAPTURE_SLOT.waitMs);
      const err = await refused;
      expect(err).toBeInstanceOf(HttpError);
      expect(err).toMatchObject({ statusCode: 503, code: 'capture_busy' });
      finishHolder();
      await holder;
      // A refused waiter left nothing behind: the slot is free.
      await expect(withCaptureSlot(fakeDb, 'user-2', async () => 'free')).resolves.toBe('free');
    });

    it('is per user and per app', async () => {
      vi.useFakeTimers();
      let finish!: () => void;
      const held = withCaptureSlot(fakeDb, 'user-3', () => new Promise<void>((r) => (finish = r)));
      await expect(withCaptureSlot(fakeDb, 'user-4', async () => 'b')).resolves.toBe('b');
      await expect(withCaptureSlot({} as never, 'user-3', async () => 'c')).resolves.toBe('c');
      finish();
      await held;
    });
  });
});

// qa's probe on https://github.com/bgoleno/opportun/pull/304#issuecomment-6764369107. Before the
// fix, every queued capture held a pool connection while it waited on the lock, so another user's
// read waited for one until the 10 s connection timeout and got a 500.
describe.runIf(testDialect === 'postgres')('#309 on Postgres: a lock held from outside', () => {
  let holder: pg.Client | undefined;
  afterEach(async () => {
    await holder?.end();
    holder = undefined;
  });

  async function holdLock(app: FastifyInstance, scope: string): Promise<void> {
    holder = new pg.Client({ connectionString: (app.config.db as PostgresConfig).url });
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock(hashtext($1))', [scope]);
  }
  const holdIngestLock = (app: FastifyInstance, userId: string) =>
    holdLock(app, ingestScope({ userId, isAdmin: false }));

  it("more captures than the pool queued behind it: another user's read still succeeds", async () => {
    const { app, a, b } = await boot();
    const poolMax = (app.config.db as PostgresConfig).poolMax;
    await holdIngestLock(app, a.userId);
    const captures = Array.from({ length: poolMax + 4 }, (_, i) => paste(a, i + 1));
    // Let them reach the lock (or the slot), as qa's did.
    await new Promise((r) => setTimeout(r, 1000));
    const began = Date.now();
    const read = await b.request({ method: 'GET', url: '/api/v1/opportunities' });
    const took = Date.now() - began;
    expect(read.statusCode, read.body).toBe(200);
    expect(took).toBeLessThan(5_000);
    await holder?.query('SELECT pg_advisory_unlock_all()');
    for (const res of await Promise.all(captures)) {
      // Never a 500: each was either refused clearly or went through once the lock was free.
      if (res.statusCode === 503) expectBusy(res);
      else expect(res.statusCode, res.body).toBe(201);
    }
  }, 60_000);

  // A capture parked inside its locked transaction. Postgres only: on SQLite that transaction
  // holds the one write gate, so the next capture waits at its first write, before the slot, as
  // every writer does there.
  it('behind a capture stalled in the lock, the next one is refused in under 10 s', async () => {
    const { a } = await boot();
    // Parked on purpose: the watchdog would fail a transaction held this long.
    onSlowTransaction(() => undefined);
    const stalled = pauseAt('discovery.ingest.locked');
    const first = paste(a, 1);
    await stalled.reached;
    const began = Date.now();
    const second = await paste(a, 2);
    const took = Date.now() - began;
    expectBusy(second);
    expect(took).toBeGreaterThanOrEqual(CAPTURE_SLOT.waitMs - 100);
    expect(took).toBeLessThan(10_000);
    stalled.release();
    expect((await first).statusCode).toBe(201);
    // The slot is free again once the stalled one is done.
    expect((await paste(a, 3)).statusCode).toBe(201);
  }, 30_000);

  it('the extension route is refused the same way behind a stalled capture', async () => {
    const { app, a } = await boot();
    // Parked on purpose: the watchdog would fail a transaction held this long.
    onSlowTransaction(() => undefined);
    const bearer = await token(a);
    const stalled = pauseAt('captureResolve.matched.locked');
    const first = push(app, bearer);
    await stalled.reached;
    const second = await push(app, bearer);
    expectBusy(second);
    stalled.release();
    expect([200, 201]).toContain((await first).statusCode);
  }, 30_000);

  it('the capture holding the slot is refused once the lock wait runs out, in under 10 s', async () => {
    const { app, a } = await boot();
    await holdIngestLock(app, a.userId);
    const began = Date.now();
    const res = await paste(a, 1);
    const took = Date.now() - began;
    expectBusy(res);
    expect(took).toBeGreaterThanOrEqual(CAPTURE_SLOT.lockTimeoutMs - 100);
    expect(took).toBeLessThan(10_000);
    // Nothing half written: the refused capture stored no lead.
    const list = await a.request({ method: 'GET', url: '/api/v1/discovery/results' });
    expect(list.json<{ items: unknown[] }>().items).toEqual([]);
    // And its run in the manual source's history is finished, with why, not "Running" for good
    // (tl on https://github.com/bgoleno/opportun/pull/318).
    const runs = await app.db
      .select()
      .from(discoveryRuns)
      .where(eq(discoveryRuns.userId, a.userId))
      .all();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.finishedAt).not.toBeNull();
    expect(runs[0]!.error).toBe(
      'Not saved: another capture of yours was still being saved. Capture it again in a few seconds.',
    );
  }, 30_000);

  it('the extension route too', async () => {
    const { app, a } = await boot();
    const bearer = await token(a);
    await holdIngestLock(app, a.userId);
    const began = Date.now();
    const res = await push(app, bearer);
    expectBusy(res);
    expect(Date.now() - began).toBeLessThan(10_000);
  }, 30_000);

  // sec on https://github.com/bgoleno/opportun/pull/318: the bound is for the lock's wait alone, and
  // the rest of the transaction keeps the usual limit.
  it('the bounded wait ends once the lock is held: lock_timeout is put back', async () => {
    const { app } = await boot();
    const before = await queryOne<{ v: string }>(
      app,
      "SELECT current_setting('lock_timeout') AS v",
    );
    await withTransaction(app.db, async (tx) => {
      await lockScope(tx, 'test.bounded', { timeoutMs: 1234 });
      const after = await rawGet<{ v: string }>(
        tx,
        sql`SELECT current_setting('lock_timeout') AS v`,
      );
      expect(after?.v).toBe(before!.v);
    });
  });

  it("the user's own lock held: the extension capture is refused too, before anything is written", async () => {
    const { app, a } = await boot();
    const bearer = await token(a);
    // settleLead takes user:<id> after the ingest lock (captureResolve.ts).
    await holdLock(app, `user:${a.userId}`);
    const began = Date.now();
    const res = await push(app, bearer);
    expectBusy(res);
    expect(Date.now() - began).toBeLessThan(10_000);
    expect(
      await app.db.select().from(opportunities).where(eq(opportunities.userId, a.userId)).all(),
    ).toEqual([]);
  }, 30_000);

  // tl on https://github.com/bgoleno/opportun/pull/318: the capture is saved by the first locked
  // transaction. A lock wait that runs out after that, in the stage move, must not answer "try
  // again", and the posting is still reconciled.
  it('a lock wait that runs out after the capture is saved answers as saved, and reconciles', async () => {
    const { app, a } = await boot();
    const bearer = await token(a);
    const saved = pauseAt('captureResolve.saved');
    const pending = push(app, bearer);
    await saved.reached;
    // A discovery run or an alert takes the user's ingest lock in the gap, and is slow.
    await holdIngestLock(app, a.userId);
    saved.release();
    const res = await pending;
    expect([200, 201], res.body).toContain(res.statusCode);
    const { opportunityId } = res.json<{ opportunityId: string }>();
    const reconcile = await app.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, POSTING_RECONCILE_KIND), eq(jobs.userId, a.userId)))
      .all();
    expect(reconcile.map((j) => (j.payload as { opportunityId: string }).opportunityId)).toEqual([
      opportunityId,
    ]);
  }, 30_000);
});
