// A ranking from older text cannot overwrite a newer one
// (https://github.com/bgoleno/opportun/issues/268, point 1). A call to the provider takes seconds,
// and a posting's text can change during it: the user completes a partial lead, or a lead job finds
// it on a board. The real route completes the lead here, and real jobs rank it. The provider is
// mocked, and its score says which text it was given. Every posting is made up.
import { runStructured } from '@opportun/ai';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { discoveryResults, jobs } from '../src/db/schema';
import { DISCOVERY_RANK_KIND, RANK_WAITING_KIND } from '../src/jobs/discoveryRank';
import { drainWaitingResults } from '../src/jobs/discoveryRankWaiting';
import { insertLeads } from '../src/jobs/discoveryRun';
import { enqueue, runNextJob } from '../src/jobs/runner';
import type { safeFetch } from '../src/lib/safeFetch';
import type { UserCtx } from '../src/repos/base';
import {
  ensureChannelSource,
  getResult,
  setRankDeferred,
  setResolution,
  setWaitingNoKey,
} from '../src/repos/discovery';
import { useApi } from './api';
import type { TestClient } from './isolation';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const boot = useApi();
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });

const CAPTURED_TEXT = 'Own the payments platform.';
const FROM_THE_LEAD = 20;
const FROM_THE_CAPTURE = 90;
const OTHER_POSTING = 55;

/** Scores by what it was sent. Calls to `parked` wait for release(). */
function provider(parked: (call: number) => boolean = () => false) {
  let calls = 0;
  let go!: () => void;
  const released = new Promise<void>((resolve) => (go = resolve));
  let began!: () => void;
  const started = new Promise<void>((resolve) => (began = resolve));
  vi.mocked(runStructured).mockImplementation(async (_deps, task, opts) => {
    if (task === 'capture.extract') {
      return {
        companyName: 'Initech',
        title: 'Staff Platform Engineer',
        location: 'Austin, TX',
        remote: 'hybrid',
        compNote: null,
        descriptionMd: CAPTURED_TEXT,
        postingUrl: 'https://careers.initech.example/jobs/42',
      } as never;
    }
    calls += 1;
    const score = opts.system.includes(CAPTURED_TEXT)
      ? FROM_THE_CAPTURE
      : opts.system.includes('Other Engineer')
        ? OTHER_POSTING
        : FROM_THE_LEAD;
    if (parked(calls)) {
      began();
      await released;
    }
    return { score, rationale: `Scored ${String(score)}.`, disqualifiers: [] } as never;
  });
  return { started, release: () => go(), calls: () => calls };
}

async function lead(app: FastifyInstance, c: TestClient, title = 'Staff Platform Engineer') {
  const ctx = ctxOf(c);
  const source = await ensureChannelSource(app.db, ctx, 'alert_email');
  const { inserted } = await insertLeads(
    app.db,
    ctx,
    [
      {
        company: 'Initech',
        title,
        location: 'Austin, TX',
        postingUrl: `https://www.linkedin.com/jobs/view/${title.length}12345678/`,
      },
    ],
    source.id,
  );
  const id = inserted[0]?.id as string;
  await app.db.delete(jobs).run();
  return id;
}

/** A partial lead waiting for budget, as one is when its rank job ran over the budget. */
async function waitingLead(app: FastifyInstance, c: TestClient, title?: string) {
  const id = await lead(app, c, title);
  await setRankDeferred(app.db, ctxOf(c), id);
  return id;
}

async function captureIt(app: FastifyInstance, c: TestClient, id: string) {
  app.jobs.services.sourceFetch = (async (url: string) => {
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof safeFetch;
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/capture',
    payload: { text: 'Staff Platform Engineer at Initech. Own the payments.', resultId: id },
  });
  expect(res.statusCode, res.body).toBe(200);
}

const runJob = (app: FastifyInstance) => runNextJob(app.db, { services: app.jobs.services });

const queued = async (app: FastifyInstance, kind: string) =>
  await app.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.kind, kind), eq(jobs.status, 'pending')))
    .all();

const startRankJob = (app: FastifyInstance, c: TestClient, id: string) =>
  enqueue(
    app.db,
    DISCOVERY_RANK_KIND,
    { resultId: id },
    { dedupeKey: `${DISCOVERY_RANK_KIND}:${id}`, userId: c.userId },
  );

beforeEach(() => {
  vi.mocked(runStructured).mockReset();
});

describe('a posting whose text changes during a ranking call', () => {
  it('a drain from the old text ending last does not overwrite the score from the new', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const id = await waitingLead(app, a);
    const call = provider((n) => n === 1);

    const drain = drainWaitingResults(app.db, ctx);
    await call.started;
    await captureIt(app, a, id);
    await runJob(app);
    expect((await getResult(app.db, ctx, id)).aiScore).toBe(FROM_THE_CAPTURE);

    call.release();
    const outcome = await drain;

    const after = await getResult(app.db, ctx, id);
    expect(after.aiScore).toBe(FROM_THE_CAPTURE);
    expect(after.aiRationale).toContain(String(FROM_THE_CAPTURE));
    expect(after.rankDeferredAt).toBeNull();
    expect(outcome.ranked).toBe(0);
    expect(call.calls()).toBe(2);
  });

  it('a drain from the old text ending first stores nothing, keeps the wait, and leaves the job to rank it', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const id = await waitingLead(app, a);
    const call = provider((n) => n === 1);

    const drain = drainWaitingResults(app.db, ctx);
    await call.started;
    await captureIt(app, a, id);
    call.release();
    const outcome = await drain;

    const between = await getResult(app.db, ctx, id);
    expect(between.aiScore).toBeNull();
    expect(between.rankDeferredAt).not.toBeNull();
    expect(outcome).toMatchObject({ ranked: 0, failed: 0, stopped: null });
    expect(await queued(app, DISCOVERY_RANK_KIND)).toHaveLength(1);

    await runJob(app);
    const after = await getResult(app.db, ctx, id);
    expect(after.aiScore).toBe(FROM_THE_CAPTURE);
    expect(after.rankDeferredAt).toBeNull();
    expect(call.calls()).toBe(2);
  });

  it('a drain goes on to the posting behind one whose text changed', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const id = await waitingLead(app, a);
    const behind = await waitingLead(app, a, 'Other Engineer');
    const call = provider((n) => n === 1);

    const drain = drainWaitingResults(app.db, ctx);
    await call.started;
    await captureIt(app, a, id);
    call.release();
    const outcome = await drain;

    expect(outcome).toMatchObject({ ranked: 1, stopped: null });
    expect((await getResult(app.db, ctx, behind)).aiScore).toBe(OTHER_POSTING);
    expect((await getResult(app.db, ctx, id)).aiScore).toBeNull();
    // Tried once this drain: the rank job the capture queued is what ranks it.
    expect(call.calls()).toBe(2);
  });

  it('a rank job from the old text stores nothing, and the new text is still ranked', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const id = await lead(app, a);
    const call = provider((n) => n === 1);

    await startRankJob(app, a, id);
    const job = runJob(app);
    await call.started;
    // The capture's own rank job dedupes onto the one running, so nothing else would rank this.
    await captureIt(app, a, id);
    expect(await queued(app, DISCOVERY_RANK_KIND)).toHaveLength(0);
    call.release();
    await job;

    const between = await getResult(app.db, ctx, id);
    expect(between.aiScore).toBeNull();
    expect(between.rankDeferredAt).not.toBeNull();
    expect(await queued(app, RANK_WAITING_KIND)).toHaveLength(1);

    await runJob(app);
    const after = await getResult(app.db, ctx, id);
    expect(after.aiScore).toBe(FROM_THE_CAPTURE);
    expect(after.rankDeferredAt).toBeNull();
    expect(call.calls()).toBe(2);
  });

  it('a rank job from the old text ending after a newer score leaves it, with no wait and no drain', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const id = await lead(app, a);
    const call = provider((n) => n === 1);

    await startRankJob(app, a, id);
    const job = runJob(app);
    await call.started;
    await captureIt(app, a, id);
    await setRankDeferred(app.db, ctx, id);
    await drainWaitingResults(app.db, ctx);
    expect((await getResult(app.db, ctx, id)).aiScore).toBe(FROM_THE_CAPTURE);

    call.release();
    await job;

    const after = await getResult(app.db, ctx, id);
    expect(after.aiScore).toBe(FROM_THE_CAPTURE);
    expect(after.rankDeferredAt).toBeNull();
    expect(await queued(app, RANK_WAITING_KIND)).toHaveLength(0);
  });

  it('a lead job finding the posting on a board counts as new text too', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const id = await waitingLead(app, a);
    const call = provider((n) => n === 1);

    const drain = drainWaitingResults(app.db, ctx);
    await call.started;
    const current = await getResult(app.db, ctx, id);
    await setResolution(app.db, ctx, id, {
      resolution: 'resolved_ats',
      resolvedSourceRef: 'gh-1',
      posting: { ...current.posting, descriptionMd: CAPTURED_TEXT },
    });
    call.release();
    await drain;

    expect((await getResult(app.db, ctx, id)).aiScore).toBeNull();
  });

  describe('anything else that happens to the row during the call', () => {
    it('a lead job that found nothing changes no text, so the score lands', async () => {
      const { app, a } = await boot();
      const ctx = ctxOf(a);
      const id = await waitingLead(app, a);
      const call = provider((n) => n === 1);

      const drain = drainWaitingResults(app.db, ctx);
      await call.started;
      await setResolution(app.db, ctx, id, {
        resolution: 'needs_capture',
        resolvedSourceRef: 'looked',
      });
      call.release();
      const outcome = await drain;

      expect((await getResult(app.db, ctx, id)).aiScore).toBe(FROM_THE_LEAD);
      expect(outcome.ranked).toBe(1);
    });

    it('a reason written to the waiting postings changes no text, so the score lands', async () => {
      const { app, a } = await boot();
      const ctx = ctxOf(a);
      const id = await waitingLead(app, a);
      const call = provider((n) => n === 1);

      const drain = drainWaitingResults(app.db, ctx);
      await call.started;
      await setWaitingNoKey(app.db, ctx);
      call.release();
      await drain;

      const after = await getResult(app.db, ctx, id);
      expect(after.aiScore).toBe(FROM_THE_LEAD);
      expect(after.rankSkipReason).toBeNull();
      expect(after.rankDeferredAt).toBeNull();
    });

    it('a posting deleted during the call is passed over', async () => {
      const { app, a } = await boot();
      const ctx = ctxOf(a);
      const id = await waitingLead(app, a);
      const call = provider((n) => n === 1);

      const drain = drainWaitingResults(app.db, ctx);
      await call.started;
      await app.db.delete(discoveryResults).where(eq(discoveryResults.id, id)).run();
      call.release();

      expect(await drain).toMatchObject({ ranked: 0, stopped: null });
    });

    it("another user's drain does not touch it", async () => {
      const { app, a, b } = await boot();
      const id = await waitingLead(app, a);
      provider();
      const run = await drainWaitingResults(app.db, ctxOf(b));
      expect(run.ranked).toBe(0);
      expect((await getResult(app.db, ctxOf(a), id)).aiScore).toBeNull();
    });
  });
});
