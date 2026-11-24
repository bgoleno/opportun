// One user's captures waiting on their ingest lock must never leave other users without a
// database connection, and a capture that cannot go on gets a clear refusal
// (https://github.com/bgoleno/opportun/issues/309; tl's design on
// https://github.com/bgoleno/opportun/issues/309#issuecomment-6765588508). A capture waits for
// the user's one capture slot in memory, holding no connection, and on Postgres waits for the
// lock itself for a bounded time. Either wait running out is 503 capture_busy with retry-after.
// The provider is mocked and every posting is made up.
import { AiUnavailableError, runStructured } from '@opportun/ai';
import { newId } from '@opportun/core';
import type { FastifyInstance } from 'fastify';
import { and, eq, ne, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostgresConfig } from '../src/config';
import { boundLockWaits, lockScope, rawGet, withTransaction, type Exec } from '../src/db/client';
import { onSlowTransaction } from '../src/db/gate';
import {
  applicationSubmissions,
  companies,
  discoveryResults,
  discoveryRuns,
  jobs,
  opportunities,
} from '../src/db/schema';
import { POSTING_RECONCILE_KIND } from '../src/lib/jobKinds';
import { CAPTURE_SLOT, withCaptureSlot } from '../src/lib/captureLimit';
import { resolveCapture } from '../src/lib/captureResolve';
import { HttpError } from '../src/lib/errors';
import { setRaceHook } from '../src/lib/racePoints';
import { ingestScope } from '../src/repos/discovery';
import { listActivities } from '../src/repos/activities';
import type { UserCtx } from '../src/repos/base';
import {
  getOpportunity,
  transitionOpportunity,
  updateOpportunity,
} from '../src/repos/opportunities';
import { useApi } from './api';
import { queryOne, testDialect } from './db';
import { JOB } from './fixtures/capture/pages';
import type { TestClient } from './isolation';
import { pauseAt } from './race';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

// Passed through: what each step of a saved capture is given to wait (#914).
vi.mock('../src/db/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/db/client')>();
  return { ...real, boundLockWaits: vi.fn(real.boundLockWaits) };
});

const PASSWORD = 'correct horse battery';
const boot = useApi();
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });

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

  // https://github.com/bgoleno/opportun/issues/914 (tl on #910): what a saved capture still writes
  // (the fill, the stage, the state) waits for locks of its own. None of those waits makes the answer
  // an error, which a retry would record twice.
  describe('#914: a lock held after the capture is recorded', () => {
    /** Tracked already, at New, so a capture of it fills, moves and checks it. */
    async function tracked(a: TestClient, over: Record<string, unknown> = {}): Promise<string> {
      const res = await a.request({
        method: 'POST',
        url: '/api/v1/opportunities',
        payload: {
          companyName: 'Initech',
          title: 'Staff Platform Engineer',
          sourceKind: 'manual',
          ...over,
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ id: string }>().id;
    }
    const entries = async (app: FastifyInstance, a: TestClient, id: string) =>
      (await listActivities(app.db, ctxOf(a), id, { limit: 50, offset: 0 })).items.filter(
        (x) => x.kind === 'capture',
      );
    const reconciles = async (app: FastifyInstance, a: TestClient) =>
      (
        await app.db
          .select()
          .from(jobs)
          .where(and(eq(jobs.kind, POSTING_RECONCILE_KIND), eq(jobs.userId, a.userId)))
          .all()
      ).map((j) => (j.payload as { opportunityId: string }).opportunityId);
    /** Pushes a capture, and holds something once it is at `point`. */
    async function pushHolding(
      app: FastifyInstance,
      bearer: string,
      point: string,
      hold: () => Promise<void>,
    ) {
      const at = pauseAt(point);
      const pending = push(app, bearer);
      await at.reached;
      await hold();
      at.release();
      return await pending;
    }
    async function holdRow(app: FastifyInstance, id: string): Promise<void> {
      holder = new pg.Client({ connectionString: (app.config.db as PostgresConfig).url });
      await holder.connect();
      await holder.query('BEGIN');
      const held = await holder.query('SELECT id FROM opportunities WHERE id = $1 FOR UPDATE', [
        id,
      ]);
      expect(held.rowCount).toBe(1);
    }

    it('the user’s lock, for a fill of a link: saved, not filled, and not recorded twice', async () => {
      const { app, a } = await boot();
      const bearer = await token(a);
      const id = await tracked(a);
      const res = await pushHolding(app, bearer, 'captureResolve.recorded', () =>
        holdLock(app, `user:${a.userId}`),
      );
      expect(res.statusCode, res.body).toBe(200);
      // The stage move and the check do not need that lock.
      expect(res.json()).toMatchObject({ opportunityId: id, stage: 'interested', filled: false });
      const opp = await getOpportunity(app.db, ctxOf(a), id);
      expect(opp).toMatchObject({ postingUrl: null, postingState: 'searching' });
      expect(await entries(app, a, id)).toHaveLength(1);
      expect(await reconciles(app, a)).toEqual([id]);

      // Made again by the user: a second capture, recorded as one, which fills.
      await holder?.query('SELECT pg_advisory_unlock_all()');
      const again = await push(app, bearer);
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).not.toHaveProperty('filled');
      expect((await getOpportunity(app.db, ctxOf(a), id)).postingUrl).toContain('/jobs/view/');
      expect(await entries(app, a, id)).toHaveLength(2);
    }, 90_000);

    it('the user’s lock, for a fill of a location', async () => {
      const { app, a } = await boot();
      const bearer = await token(a);
      // Captured without a location first; then the model reads it from the page.
      const first = await push(app, bearer);
      expect(first.statusCode, first.body).toBe(201);
      const { opportunityId: id } = first.json<{ opportunityId: string }>();
      vi.mocked(runStructured).mockResolvedValue({
        kind: 'job',
        name: null,
        headline: null,
        company: 'Initech',
        title: 'Staff Platform Engineer',
        location: 'Austin, TX',
        compNote: null,
        descriptionMd: null,
      } as never);
      const res = await pushHolding(app, bearer, 'captureResolve.recorded', () =>
        holdLock(app, `user:${a.userId}`),
      );
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ opportunityId: id, filled: false });
      expect((await getOpportunity(app.db, ctxOf(a), id)).location).toBeNull();
      expect(await entries(app, a, id)).toHaveLength(2);
      expect(await reconciles(app, a)).toEqual([id]);
    }, 90_000);

    it('the attempt’s lock', async () => {
      const { app, a } = await boot();
      const bearer = await token(a);
      const id = await tracked(a);
      const attempt = newId();
      await app.db
        .insert(applicationSubmissions)
        .values({
          id: attempt,
          userId: a.userId,
          opportunityId: id,
          atsKind: 'ats_greenhouse',
          atsRef: 'initech',
          atsExternalId: '1',
          destinationUrl: 'https://boards.greenhouse.io/initech/jobs/1',
          status: 'draft',
          idempotencyKey: attempt,
          fields: {},
          answers: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        .run();
      const res = await pushHolding(app, bearer, 'captureResolve.recorded', () =>
        holdLock(app, `submission:${attempt}`),
      );
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ opportunityId: id, stage: 'interested', filled: false });
      expect((await getOpportunity(app.db, ctxOf(a), id)).postingUrl).toBeNull();
      expect(await entries(app, a, id)).toHaveLength(1);
      expect(await reconciles(app, a)).toEqual([id]);
    }, 90_000);

    it('the opportunity’s row, through the fill, the stage move and the state: one budget for all', async () => {
      const { app, a } = await boot();
      const bearer = await token(a);
      const id = await tracked(a);
      vi.mocked(boundLockWaits).mockClear();
      const res = await pushHolding(app, bearer, 'captureResolve.recorded', () => holdRow(app, id));
      // The entry's own bound, then one budget: the fill is given it and spends it, and nothing is
      // left for the stage move and the state.
      const [entry, fill, ...rest] = vi.mocked(boundLockWaits).mock.calls.map(([, ms]) => ms);
      expect(entry).toBe(CAPTURE_SLOT.lockTimeoutMs);
      expect(fill).toBeGreaterThan(CAPTURE_SLOT.lockTimeoutMs / 2);
      expect(rest).toEqual([1, 1]);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ opportunityId: id, stage: null, filled: false });
      expect(await getOpportunity(app.db, ctxOf(a), id)).toMatchObject({
        stage: 'discovered',
        postingUrl: null,
        postingState: null,
      });
      expect(await entries(app, a, id)).toHaveLength(1);
      expect(await reconciles(app, a)).toEqual([id]);
    }, 120_000);

    it('the row before the capture is recorded: refused, with no entry, and recorded once after', async () => {
      const { app, a } = await boot();
      const bearer = await token(a);
      const id = await tracked(a);
      const res = await pushHolding(app, bearer, 'captureResolve.settled', () => holdRow(app, id));
      expectBusy(res);
      expect(await entries(app, a, id)).toEqual([]);
      expect(await reconciles(app, a)).toEqual([]);
      await holder?.query('ROLLBACK');
      const again = await push(app, bearer);
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).toMatchObject({ opportunityId: id });
      expect(await entries(app, a, id)).toHaveLength(1);
      // The lead the refused one accepted is this one's too.
      const leads = await app.db
        .select()
        .from(discoveryResults)
        .where(eq(discoveryResults.userId, a.userId))
        .all();
      expect(leads).toHaveLength(1);
    }, 90_000);

    // tl on #955: a description without its fingerprint would read as the user's own, for good.
    it('the row of a new opportunity, before the capture is recorded: its text stays the system’s', async () => {
      const { app, a } = await boot();
      const bearer = await token(a);
      const only = async () => {
        const rows = await app.db
          .select({ id: opportunities.id })
          .from(opportunities)
          .where(eq(opportunities.userId, a.userId))
          .all();
        expect(rows).toHaveLength(1);
        return rows[0]!.id;
      };
      const res = await pushHolding(app, bearer, 'captureResolve.settled', async () =>
        holdRow(app, await only()),
      );
      expectBusy(res);
      const id = await only();
      expect(await entries(app, a, id)).toEqual([]);
      await holder?.query('ROLLBACK');
      const again = await push(app, bearer);
      expect(again.statusCode, again.body).toBe(200);
      const opp = await getOpportunity(app.db, ctxOf(a), id);
      expect(opp.descriptionMd).toContain('TPS reporting');
      expect(opp.descriptionFingerprint).not.toBeNull();
      expect(opp.descriptionIsUserWritten).toBe(false);
      expect(await entries(app, a, id)).toHaveLength(1);
    }, 90_000);

    it('the row of one kept apart from another: saved, without the note', async () => {
      const { app, a } = await boot();
      const bearer = await token(a);
      // Another posting with the same key: the capture of JOB is kept apart from it.
      const other = await app.inject({
        method: 'POST',
        url: '/api/v1/connector/capture',
        headers: { authorization: `Bearer ${bearer}` },
        payload: { ...JOB, url: JOB.url.replace('3901234567', '3901234599') },
      });
      expect(other.statusCode, other.body).toBe(201);
      const { opportunityId: first } = other.json<{ opportunityId: string }>();
      const res = await pushHolding(app, bearer, 'captureResolve.recorded', async () => {
        const rows = await app.db
          .select({ id: opportunities.id })
          .from(opportunities)
          .where(and(eq(opportunities.userId, a.userId), ne(opportunities.id, first)))
          .all();
        expect(rows).toHaveLength(1);
        await holdRow(app, rows[0]!.id);
      });
      expect(res.statusCode, res.body).toBe(201);
      const { opportunityId: id } = res.json<{ opportunityId: string }>();
      const titles = (
        await listActivities(app.db, ctxOf(a), id, { limit: 50, offset: 0 })
      ).items.map((x) => x.title);
      expect(titles.filter((t) => t.startsWith('Kept apart'))).toEqual([]);
      expect(titles.filter((t) => t.startsWith('Captured'))).toHaveLength(1);
      expect(await reconciles(app, a)).toContain(id);
    }, 120_000);

    it('the bound ends with its transaction, and others have none', async () => {
      const { app } = await boot();
      const setting = async (exec: Exec) =>
        (await rawGet<{ v: string }>(exec, sql`SELECT current_setting('lock_timeout') AS v`))?.v;
      const usual = await setting(app.db);
      await withTransaction(app.db, async (tx) => {
        await boundLockWaits(tx, 1234);
        expect(await setting(tx)).toBe('1234ms');
        await withTransaction(tx, async (inner) => expect(await setting(inner)).toBe('1234ms'));
        // lockScope's own bound puts this one back, not the server's.
        await lockScope(tx, 'test.914', { timeoutMs: 99 });
        expect(await setting(tx)).toBe('1234ms');
      });
      // Every connection of the pool, as any of them may have run it.
      const { poolMax } = app.config.db as PostgresConfig;
      for (const v of await Promise.all(Array.from({ length: poolMax }, () => setting(app.db)))) {
        expect(v).toBe(usual);
      }
      await withTransaction(app.db, async (tx) => expect(await setting(tx)).toBe(usual));
    });
  });
});

// Both engines.
describe('#914: a saved capture whose step gave up a wait', () => {
  const pgError = (code: string) =>
    Object.assign(new Error('gave up'), { code, severity: 'ERROR' });
  const failAt = (point: string, err: () => Error) =>
    setRaceHook(async (reached) => {
      if (reached === point) throw err();
    });
  const capture = async (over: Record<string, unknown> = {}) => {
    const { app, a } = await boot();
    const bearer = await token(a);
    const made = await a.request({
      method: 'POST',
      url: '/api/v1/opportunities',
      payload: {
        companyName: 'Initech',
        title: 'Staff Platform Engineer',
        sourceKind: 'manual',
        ...over,
      },
    });
    return { app, a, bearer, id: made.json<{ id: string }>().id };
  };

  it.each(['55P03', '57014', '40P01'])('%s in the fill: saved, and not filled', async (code) => {
    const { app, a, bearer, id } = await capture();
    failAt('opportunities.update.locked', () => pgError(code));
    const res = await push(app, bearer);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ opportunityId: id, stage: 'interested', filled: false });
    expect((await getOpportunity(app.db, ctxOf(a), id)).postingUrl).toBeNull();
  });

  it('the step is logged by name, with nothing of the capture', async () => {
    const { app, a, id } = await capture();
    failAt('opportunities.update.locked', () => pgError('55P03'));
    const warn = vi.fn();
    const out = await resolveCapture(app.db, ctxOf(a), {
      posting: {
        company: 'Initech',
        title: 'Staff Platform Engineer',
        postingUrl: 'https://www.linkedin.com/jobs/view/3901234567/',
      } as never,
      captureText: 'The page as read.',
      siteId: 'linkedin',
      log: { warn } as never,
    });
    expect(out).toMatchObject({ opportunityId: id, filled: false });
    expect(warn.mock.calls).toEqual([
      [{ 'opportun.opportunity.id': id }, 'saved capture: the fill gave up a lock wait'],
    ]);
  });

  it('any other error in the fill still fails the capture', async () => {
    const { app, bearer } = await capture();
    failAt('opportunities.update.locked', () => new Error('the fill broke'));
    const res = await push(app, bearer);
    expect(res.statusCode, res.body).toBe(500);
  });

  // tl on #955: the move is committed, so it is what the answer says, whatever follows it.
  it.each(['55P03', '57014', '40P01'])(
    '%s after the stage move: the answer says it moved',
    async (code) => {
      const { app, a, bearer, id } = await capture();
      let queued = 0;
      setRaceHook(async (point) => {
        if (point !== 'jobs.enqueue') return;
        queued += 1;
        // The first is the company's lookup, the second the posting's check.
        if (queued === 1) throw pgError(code);
      });
      const res = await push(app, bearer);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ opportunityId: id, stage: 'interested' });
      const kinds = (
        await app.db.select({ kind: jobs.kind }).from(jobs).where(eq(jobs.userId, a.userId)).all()
      ).map((j) => j.kind);
      expect(kinds).toEqual([POSTING_RECONCILE_KIND]);
    },
  );

  it('a duplicate refused for a fill with no location is not tried again', async () => {
    const { app, bearer } = await capture();
    let tries = 0;
    setRaceHook(async (point) => {
      if (point !== 'opportunities.update.locked') return;
      tries += 1;
      throw new HttpError(409, 'duplicate');
    });
    const res = await push(app, bearer);
    expect(res.statusCode, res.body).toBe(409);
    expect(tries).toBe(1);
  });

  // em and tl on #955: the fill's location is another opportunity's of theirs. Refused after the
  // entry was recorded, each retry would record it again.
  describe('a location that is another opportunity’s', () => {
    /** Captured without a location or pay; one with the location added by hand; then both are read. */
    async function heldLocation() {
      const { app, a } = await boot();
      const bearer = await token(a);
      const first = await push(app, bearer);
      expect(first.statusCode, first.body).toBe(201);
      const { opportunityId: id } = first.json<{ opportunityId: string }>();
      const other = await a.request({
        method: 'POST',
        url: '/api/v1/opportunities',
        payload: {
          companyName: 'Initech',
          title: 'Staff Platform Engineer',
          location: 'Austin, TX',
          sourceKind: 'manual',
        },
      });
      expect(other.statusCode, other.body).toBe(201);
      vi.mocked(runStructured).mockResolvedValue({
        kind: 'job',
        name: null,
        headline: null,
        company: 'Initech',
        title: 'Staff Platform Engineer',
        location: 'Austin, TX',
        compNote: '$200K/yr - $240K/yr',
        descriptionMd: null,
      } as never);
      const row = async (which = id) =>
        (await app.db.select().from(opportunities).where(eq(opportunities.id, which)).get())!;
      const entries = async () =>
        (await listActivities(app.db, ctxOf(a), id, { limit: 50, offset: 0 })).items.filter(
          (x) => x.kind === 'capture',
        );
      return { app, bearer, id, row, entries, other: other.json<{ id: string }>().id };
    }

    it('is left out, the rest is filled, and each capture is answered as saved', async () => {
      const { app, bearer, id, row, entries, other } = await heldLocation();
      const before = await row();
      const holder = await row(other);
      const res = await push(app, bearer);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ opportunityId: id });
      expect(res.json()).not.toHaveProperty('filled');
      expect(await row()).toMatchObject({
        location: null,
        dedupeKey: before.dedupeKey,
        compNote: '$200K/yr - $240K/yr',
      });
      expect(await row(other)).toEqual(holder);
      expect(await entries()).toHaveLength(2);

      // Again, with the location alone left to fill: nothing is written for it.
      let writes = 0;
      setRaceHook(async (point) => {
        if (point === 'opportunities.update.locked') writes += 1;
      });
      const again = await push(app, bearer);
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json()).not.toHaveProperty('filled');
      expect(writes).toBe(0);
      expect(await entries()).toHaveLength(3);
    });

    it('a wait that ends in the second try is the fill’s', async () => {
      const { app, bearer, row, entries } = await heldLocation();
      // The first try is refused before it gets here.
      failAt('opportunities.update.locked', () => pgError('55P03'));
      const res = await push(app, bearer);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ filled: false });
      expect((await row()).compNote).toBeNull();
      expect(await entries()).toHaveLength(2);
    });

    // sec on #955: only the key's own refusal leaves the location out.
    it('a refusal with another code is not taken for the location’s', async () => {
      const { app, bearer, row, entries } = await heldLocation();
      let tries = 0;
      setRaceHook(async (point) => {
        if (point !== 'opportunities.update.locked') return;
        tries += 1;
        throw new HttpError(409, 'another_code');
      });
      // Where the location is free, so the refusal is the only one.
      await app.db.delete(opportunities).where(eq(opportunities.location, 'Austin, TX')).run();
      const res = await push(app, bearer);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error.code).toBe('another_code');
      expect(tries).toBe(1);
      expect((await row()).compNote).toBeNull();
      expect(await entries()).toHaveLength(2);
    });

    it('any other refusal of the fill still fails the capture', async () => {
      const { app, bearer, entries } = await heldLocation();
      failAt('opportunities.update.locked', () => new HttpError(409, 'duplicate'));
      // The second try has no location, so a 409 there is not the key's.
      const res = await push(app, bearer);
      expect(res.statusCode, res.body).toBe(409);
      expect(await entries()).toHaveLength(2);
    });
  });

  it('a fill nobody blocks, and a capture with nothing to fill, send no filled', async () => {
    const { app, a, bearer, id } = await capture();
    const first = await push(app, bearer);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).not.toHaveProperty('filled');
    expect((await getOpportunity(app.db, ctxOf(a), id)).postingUrl).toContain('/jobs/view/');
    const second = await push(app, bearer);
    expect(second.json()).not.toHaveProperty('filled');
  });

  // updateOpportunity with a transaction of its caller's: all it writes is that transaction's.
  it('updateOpportunity in its caller’s transaction is undone with it', async () => {
    const { app, a, id } = await capture();
    const before = await getOpportunity(app.db, ctxOf(a), id);
    const found = async (q: string) =>
      (
        await a.request({ method: 'GET', url: `/api/v1/search?q=${encodeURIComponent(q)}` })
      ).body.includes(id);
    await expect(
      withTransaction(app.db, async (tx) => {
        await updateOpportunity(tx, ctxOf(a), id, {
          title: 'Zeppelin Keeper',
          companyName: 'Hooli',
          location: 'Berlin',
          descriptionMd: 'Keeps zeppelins.',
        });
        throw new Error('undo');
      }),
    ).rejects.toThrow('undo');
    expect(await getOpportunity(app.db, ctxOf(a), id)).toEqual(before);
    expect(await found('Zeppelin')).toBe(false);
    const row = await app.db.select().from(opportunities).where(eq(opportunities.id, id)).get();
    expect(row!.dedupeKey).not.toContain('zeppelin');
    expect(
      (await app.db.select().from(companies).where(eq(companies.userId, a.userId)).all()).map(
        (c) => c.name,
      ),
    ).not.toContain('Hooli');

    await withTransaction(app.db, (tx) =>
      updateOpportunity(tx, ctxOf(a), id, { title: 'Zeppelin Keeper', location: 'Berlin' }),
    );
    expect(await found('Zeppelin')).toBe(true);
    const after = await app.db.select().from(opportunities).where(eq(opportunities.id, id)).get();
    expect(after!.dedupeKey).toContain('zeppelin');
  });
});
