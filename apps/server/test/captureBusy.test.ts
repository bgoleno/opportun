// One user's captures waiting on their ingest lock must never leave other users without a
// database connection, and a capture that cannot go on gets a clear refusal
// (https://github.com/bgoleno/opportun/issues/309; tl's design on
// https://github.com/bgoleno/opportun/issues/309#issuecomment-6765588508). A capture waits for
// the user's one capture slot in memory, holding no connection, and on Postgres waits for the
// lock itself for a bounded time. Either wait running out is 503 capture_busy with retry-after.
// The provider is mocked and every posting is made up.
import { AiUnavailableError, runStructured } from '@opportun/ai';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostgresConfig } from '../src/config';
import { onSlowTransaction } from '../src/db/gate';
import { CAPTURE_SLOT, withCaptureSlot } from '../src/lib/captureLimit';
import { HttpError } from '../src/lib/errors';
import { ingestScope } from '../src/repos/discovery';
import { useApi } from './api';
import { testDialect } from './db';
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

  async function holdIngestLock(app: FastifyInstance, userId: string): Promise<void> {
    holder = new pg.Client({ connectionString: (app.config.db as PostgresConfig).url });
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock(hashtext($1))', [
      ingestScope({ userId, isAdmin: false }),
    ]);
  }

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
});
