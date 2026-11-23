// A posting check that ends without writing its outcome (https://github.com/bgoleno/opportun/issues/869)
// or whose opportunity goes while it runs (https://github.com/bgoleno/opportun/issues/897). tl's test
// list is on #869.
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activities, jobs, opportunities } from '../src/db/schema';
import { postingReconcileJob } from '../src/jobs/postingReconcile';
import type { JobServices } from '../src/jobs/registry';
import { recoverStaleJobs, runNextJob, startRunner } from '../src/jobs/runner';
import { POSTING_RECONCILE_KIND } from '../src/lib/jobKinds';
import { enqueue } from '../src/lib/jobQueue';
import { settleAbandonedChecks, settleUnfinishedCheck } from '../src/lib/postingChecks';
import { notFound } from '../src/lib/errors';
import { setRaceHook } from '../src/lib/racePoints';
import type { safeFetch } from '../src/lib/safeFetch';
import { createCompany } from '../src/repos/companies';
import {
  createOpportunity,
  deleteOpportunity,
  mergeOpportunities,
  setPostingState,
} from '../src/repos/opportunities';
import { useApi } from './api';
import { restartableTestApp } from './helpers';
import { registerTwoUsers, type TestClient } from './isolation';

/** When set, the check's own outcome can't be written either, as with a company that is gone. */
let flagFails = false;
vi.mock('../src/lib/postingReconcile', async (orig) => {
  const real = await orig<typeof import('../src/lib/postingReconcile')>();
  return {
    ...real,
    flag: (...args: Parameters<typeof real.flag>) => {
      if (flagFails) throw notFound();
      return real.flag(...args);
    },
    writeReconcileNote: (...args: Parameters<typeof real.writeReconcileNote>) => {
      if (flagFails) throw notFound();
      return real.writeReconcileNote(...args);
    },
  };
});

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
const log = { warn: () => {}, info: () => {}, error: () => {} } as never;
afterEach(() => {
  setRaceHook(undefined);
  flagFails = false;
});

const NOTE = {
  title: 'Posting check failed',
  bodyMd: "The check of the company's board did not finish. Use Find posting to check again.",
};

/** An opportunity a capture left `searching`, on a company whose board is known. */
async function searching(app: FastifyInstance, c: TestClient, title = 'Staff Product Manager') {
  const opp = await createOpportunity(app.db, ctxOf(c), {
    companyName: 'Soylent',
    title,
    sourceKind: 'discovery',
  });
  await setPostingState(app.db, ctxOf(c), opp.id, {
    postingState: 'searching',
    postingStateDetail: null,
  });
  return opp;
}

const check = (app: FastifyInstance, c: TestClient, opportunityId: string) =>
  enqueue(
    app.db,
    POSTING_RECONCILE_KIND,
    { opportunityId },
    { userId: c.userId, dedupeKey: `${POSTING_RECONCILE_KIND}:${opportunityId}` },
  );

const setJob = (app: FastifyInstance, id: string, set: Partial<typeof jobs.$inferInsert>) =>
  app.db.update(jobs).set(set).where(eq(jobs.id, id)).run();

const jobOf = async (app: FastifyInstance, id: string) =>
  (await app.db.select().from(jobs).where(eq(jobs.id, id)).get())!;

async function state(app: FastifyInstance, id: string) {
  const row = await app.db.select().from(opportunities).where(eq(opportunities.id, id)).get();
  return row === undefined ? undefined : [row.postingState, row.postingStateDetail];
}

const notes = (app: FastifyInstance, id: string) =>
  app.db
    .select({ title: activities.title, bodyMd: activities.bodyMd })
    .from(activities)
    .where(and(eq(activities.opportunityId, id), eq(activities.kind, 'note')))
    .all();

/** Runs the check now, whatever its backoff: the app's own scheduled jobs are not due. */
async function runCheck(app: FastifyInstance, id: string, services: Partial<JobServices>) {
  await setJob(app, id, { runAt: 0 });
  expect(await runNextJob(app.db, { services })).toBe(true);
}

const SETTLED = ['needs_review', 'failed'];
const SEARCHING = ['searching', null];

describe('at boot, a check nothing is left to finish ends (#869)', () => {
  it('a dead job with the posting still searching: did not finish, with one note, on a restart', async () => {
    const handle = await restartableTestApp();
    try {
      const first = handle.app();
      const { a, b } = await registerTwoUsers(first);
      const dead = await searching(first, a);
      await setJob(first, await check(first, a, dead.id), { status: 'dead', attempts: 3 });
      const lost = await searching(first, b, 'No job at all');
      const pending = await searching(first, a, 'Pending');
      await check(first, a, pending.id);
      const running = await searching(first, a, 'Running');
      await setJob(first, await check(first, a, running.id), { status: 'running' });
      expect(await state(first, dead.id)).toEqual(SEARCHING);

      const app = await handle.restart({});

      expect(await state(app, dead.id)).toEqual(SETTLED);
      expect(await notes(app, dead.id)).toEqual([NOTE]);
      expect(await state(app, lost.id)).toEqual(SETTLED);
      expect(await state(app, pending.id)).toEqual(SEARCHING);
      expect(await notes(app, pending.id)).toEqual([]);
      expect(await state(app, running.id)).toEqual(SEARCHING);
      // Once only: a second start finds nothing to do.
      await handle.restart({});
      expect(await notes(handle.app(), dead.id)).toEqual([NOTE]);
    } finally {
      await handle.close();
    }
  });

  it('one that cannot be settled does not stop the others', async () => {
    const { app, a } = await boot();
    const opp = await searching(app, a);
    flagFails = true;
    await expect(settleAbandonedChecks(app.db, log)).resolves.toBe(0);
    flagFails = false;
    const other = await searching(app, a, 'Other');
    await expect(settleAbandonedChecks(app.db, log)).resolves.toBe(1);
    expect(await state(app, other.id)).toEqual(SETTLED);
    expect(await state(app, opp.id)).toEqual(SETTLED);
  });
});

describe('a check whose job dies ends its posting (#869)', () => {
  it('orphaned at its last attempt, when the runner starts', async () => {
    const { app, a } = await boot();
    const opp = await searching(app, a);
    const id = await check(app, a, opp.id);
    await setJob(app, id, { status: 'running', lockedBy: 'gone', lockedAt: 1, attempts: 3 });
    // Boot's sweep leaves it: the job still reads as running.
    expect(await settleAbandonedChecks(app.db, log)).toBe(0);

    const runner = startRunner(app.db, { services: app.jobs.services, intervalMs: 1_000_000 });
    await runner.stop();

    expect((await jobOf(app, id)).status).toBe('dead');
    expect(await state(app, opp.id)).toEqual(SETTLED);
    expect(await notes(app, opp.id)).toEqual([NOTE]);
  });

  it('pending at its attempt limit, when the runner starts', async () => {
    const { app, a } = await boot();
    const opp = await searching(app, a);
    const id = await check(app, a, opp.id);
    await setJob(app, id, { attempts: 3 });
    await recoverStaleJobs(app.db);
    expect((await jobOf(app, id)).status).toBe('dead');
    expect(await state(app, opp.id)).toEqual(SETTLED);
  });

  it('its retries exhausted: a real failure still retries, then ends dead', async () => {
    const { app, a } = await boot();
    const opp = await searching(app, a);
    const id = await check(app, a, opp.id);
    // No source fetch service: the check fails before it starts, every time.
    const run = () => runCheck(app, id, { log: app.log });
    for (const [attempt, status] of [
      [1, 'pending'],
      [2, 'pending'],
    ] as const) {
      await run();
      expect(await jobOf(app, id)).toMatchObject({ status, attempts: attempt });
      expect(await state(app, opp.id)).toEqual(SEARCHING);
    }
    await run();
    expect(await jobOf(app, id)).toMatchObject({ status: 'dead', attempts: 3 });
    expect((await jobOf(app, id)).lastError).toContain('job service unavailable');
    expect(await state(app, opp.id)).toEqual(SETTLED);
    expect(await notes(app, opp.id)).toEqual([NOTE]);
  });

  it('with attempts left, recovery queues it again and the posting is still being checked', async () => {
    const { app, a } = await boot();
    const opp = await searching(app, a);
    const id = await check(app, a, opp.id);
    await setJob(app, id, { status: 'running', lockedBy: 'gone', lockedAt: 1, attempts: 1 });
    await recoverStaleJobs(app.db);
    expect((await jobOf(app, id)).status).toBe('pending');
    expect(await state(app, opp.id)).toEqual(SEARCHING);
  });

  it('unchanged while a newer check is pending or running, and once no longer searching', async () => {
    const { app, a, b } = await boot();
    const opp = await searching(app, a);
    const old = await check(app, a, opp.id);
    await setJob(app, old, { status: 'dead', attempts: 3 });
    const newer = await check(app, a, opp.id);
    for (const status of ['pending', 'running'] as const) {
      await setJob(app, newer, { status });
      expect(await settleUnfinishedCheck(app.db, ctxOf(a), opp.id)).toBe(false);
      expect(await state(app, opp.id)).toEqual(SEARCHING);
    }
    await setJob(app, newer, { status: 'done' });
    // Not another user's to settle.
    expect(await settleUnfinishedCheck(app.db, ctxOf(b), opp.id)).toBe(false);
    await setPostingState(app.db, ctxOf(a), opp.id, {
      postingState: 'confirmed',
      postingStateDetail: 'user_confirmed',
    });
    expect(await settleUnfinishedCheck(app.db, ctxOf(a), opp.id)).toBe(false);
    expect(await state(app, opp.id)).toEqual(['confirmed', 'user_confirmed']);
    expect(await notes(app, opp.id)).toEqual([]);
  });
});

describe('a Confirm that lands while a check is being ended (#869)', () => {
  it('stands: the note is written, and the state is the user’s', async () => {
    const { app, a } = await boot();
    const opp = await searching(app, a);
    setRaceHook(async (point) => {
      if (point !== 'postingChecks.settled') return;
      setRaceHook(undefined);
      await setPostingState(app.db, ctxOf(a), opp.id, {
        postingState: 'confirmed',
        postingStateDetail: 'user_confirmed',
      });
    });
    expect(await settleUnfinishedCheck(app.db, ctxOf(a), opp.id)).toBe(true);
    expect(await state(app, opp.id)).toEqual(['confirmed', 'user_confirmed']);
    expect(await notes(app, opp.id)).toEqual([NOTE]);
  });
});

describe('a check whose opportunity goes while its board is read ends quietly (#897)', () => {
  /** A board read that is held until released, then fails. */
  function heldBoard(app: FastifyInstance) {
    let reached!: () => void;
    let release!: () => void;
    const reading = new Promise<void>((r) => (reached = r));
    const held = new Promise<void>((r) => (release = r));
    app.jobs.services.sourceFetch = (async (url: string) => {
      reached();
      await held;
      return { status: 200, headers: new Headers(), body: Buffer.from('{"jobs":[]}'), url };
    }) as unknown as typeof safeFetch;
    return { reading, release };
  }

  async function onGreenhouse(app: FastifyInstance, a: TestClient) {
    await createCompany(app.db, ctxOf(a), {
      name: 'Soylent',
      atsKind: 'ats_greenhouse',
      atsRef: 'soylent',
      atsVerifiedAt: Date.now(),
    });
    return searching(app, a);
  }

  it('deleted: the job ends done, not retried, and nothing is written', async () => {
    const { app, a } = await boot();
    const opp = await onGreenhouse(app, a);
    const id = await check(app, a, opp.id);
    const { reading, release } = heldBoard(app);
    const draining = app.jobs.drain();
    await reading;
    await deleteOpportunity(app.db, ctxOf(a), opp.id);
    release();
    await draining;
    expect(await jobOf(app, id)).toMatchObject({
      status: 'done',
      attempts: 1,
      result: { status: 'gone' },
      lastError: null,
    });
    expect(await state(app, opp.id)).toBeUndefined();
    expect(await app.db.select().from(activities).all()).toEqual([]);
  });

  it('merged into another: the same, and the one it was merged into is as it was', async () => {
    const { app, a } = await boot();
    const opp = await onGreenhouse(app, a);
    const keep = await createOpportunity(app.db, ctxOf(a), {
      companyName: 'Soylent',
      title: 'Kept',
      sourceKind: 'manual',
    });
    const id = await check(app, a, opp.id);
    const { reading, release } = heldBoard(app);
    const draining = app.jobs.drain();
    await reading;
    await mergeOpportunities(app.db, ctxOf(a), keep.id, opp.id);
    const merged = await notes(app, keep.id);
    const before = await state(app, keep.id);
    release();
    await draining;
    expect(await jobOf(app, id)).toMatchObject({
      status: 'done',
      attempts: 1,
      result: { status: 'gone' },
    });
    expect(await state(app, keep.id)).toEqual(before);
    expect(await notes(app, keep.id)).toEqual(merged);
  });

  it('a 404 of anything else, with the opportunity still there, still retries and ends dead', async () => {
    const { app, a } = await boot();
    const opp = await searching(app, a);
    const id = await check(app, a, opp.id);
    flagFails = true;
    const run = () => runCheck(app, id, app.jobs.services);
    for (const status of ['pending', 'pending', 'dead']) {
      await run();
      expect((await jobOf(app, id)).status).toBe(status);
    }
    expect((await jobOf(app, id)).lastError).toContain('not_found');
    expect(postingReconcileJob.maxAttempts).toBe(3);
  });
});
