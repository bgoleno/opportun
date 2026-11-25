// Capture posting answers a job it has already with where that is: the queue, the pipeline, or Decided
// (https://github.com/bgoleno/opportun/issues/1053). It said "already in your queue or pipeline" of a
// dismissed one too. Nothing is stored either way. The provider is mocked, every posting is made up.
import { runStructured } from '@opportun/ai';
import { dedupeKey, type NormalizedPosting } from '@opportun/core';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { discoveryResults, dismissalFeedback, opportunities } from '../src/db/schema';
import { createActivity } from '../src/repos/activities';
import { createCompany } from '../src/repos/companies';
import {
  createRun,
  createSource,
  ensureChannelSource,
  insertResult,
  listRuns,
} from '../src/repos/discovery';
import {
  createOpportunity,
  deleteOpportunity,
  updateOpportunity,
} from '../src/repos/opportunities';
import { useApi } from './api';
import type { TestClient } from './isolation';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
beforeEach(() => void vi.mocked(runStructured).mockReset());

const JOB = {
  company: 'Initech',
  title: 'Staff Platform Engineer',
  location: 'Austin, TX',
  postingUrl: 'https://www.linkedin.com/jobs/view/3912345678/',
  descriptionMd: 'Own the payments platform.',
} satisfies NormalizedPosting;
const KEY = dedupeKey(JOB.company, JOB.title, JOB.location);

async function setup() {
  const { app, a, b } = await boot();
  const ctx = ctxOf(a);
  const { db } = app;
  const capture = async (over: { title?: string; location?: string } = {}) => {
    vi.mocked(runStructured).mockResolvedValueOnce({
      companyName: JOB.company,
      title: JOB.title,
      location: JOB.location,
      remote: null,
      compNote: null,
      descriptionMd: JOB.descriptionMd,
      postingUrl: JOB.postingUrl,
      ...over,
    });
    return await a.request({
      method: 'POST',
      url: '/api/v1/capture',
      payload: { text: 'Staff Platform Engineer at Initech' },
    });
  };
  /** Captured, and so in the queue. */
  const captured = async (): Promise<string> => {
    const res = await capture();
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { resultId: string }).resultId;
  };
  const send = async (url: string, payload: Record<string, unknown> = {}) => {
    const res = await a.request({ method: 'POST', url: `/api/v1${url}`, payload });
    expect(res.statusCode, res.body).toBeLessThan(300);
    return res.json() as { opportunity?: { id: string }; opportunityId?: string };
  };
  const dismiss = (id: string) => send(`/discovery/results/${id}/dismiss`, { reason: 'stale' });
  const accept = async (id: string): Promise<string> => {
    await send(`/discovery/results/${id}/accept`);
    const row = (await db.select().from(discoveryResults).all()).find((r) => r.id === id);
    return row!.opportunityId!;
  };
  const stage = (id: string, to: 'dismissed') =>
    db.update(opportunities).set({ stage: to }).where(eq(opportunities.id, id)).run();
  /** A result of another source: a card of the job beside the one captured. */
  const onBoard = async () => {
    const source = await createSource(db, ctx, { kind: 'ats_lever', config: { org: 'initech' } });
    const run = await createRun(db, ctx, { sourceId: source.id });
    const posting = { ...JOB, externalId: 'lever-1' };
    return (
      await insertResult(db, ctx, { runId: run.id, posting, dedupeKey: KEY, resolution: 'full' })
    ).id;
  };
  const stored = async () => ({
    results: await db.select().from(discoveryResults).all(),
    opportunities: await db.select().from(opportunities).all(),
    feedback: await db.select().from(dismissalFeedback).all(),
  });
  /** Captured again: what it answers, that nothing but the run is stored, and what the run counts. */
  const again = async (over: { title?: string; location?: string } = {}) => {
    const before = await stored();
    const res = await capture(over);
    expect(res.statusCode, res.body).toBe(409);
    expect(await stored()).toEqual(before);
    const source = await ensureChannelSource(db, ctx, 'manual');
    const runs = (await listRuns(db, ctx, source.id, { limit: 50, offset: 0 })).items;
    expect(runs.filter((r) => r.stats?.duplicates === 1)).toHaveLength(1);
    return (res.json() as { error: unknown }).error;
  };
  return { app, db, a, b, ctx, capture, captured, dismiss, accept, stage, onBoard, again };
}

describe('a posting captured again is answered with where its job is (#1053)', () => {
  it('in the queue', async () => {
    const s = await setup();
    await s.captured();
    expect(await s.again()).toEqual({ code: 'duplicate', place: 'queue' });
  });

  it('dismissed', async () => {
    const s = await setup();
    await s.dismiss(await s.captured());
    expect(await s.again()).toEqual({ code: 'duplicate', place: 'dismissed' });
  });

  it('dismissed at its first capture, as its company is denied', async () => {
    const s = await setup();
    await createCompany(s.db, s.ctx, { name: 'Initech', status: 'denied' });
    expect((await s.capture()).json()).toMatchObject({ error: { code: 'company_denied' } });
    expect(await s.again()).toEqual({ code: 'duplicate', place: 'dismissed' });
  });

  it('accepted: its opportunity', async () => {
    const s = await setup();
    const existingId = await s.accept(await s.captured());
    expect(await s.again()).toEqual({ code: 'duplicate', place: 'pipeline', existingId });
  });

  it('accepted, and its opportunity has another title by now', async () => {
    const s = await setup();
    const existingId = await s.accept(await s.captured());
    await updateOpportunity(s.db, s.ctx, existingId, { title: 'Head of Payments' });
    expect(await s.again()).toEqual({ code: 'duplicate', place: 'pipeline', existingId });
  });

  it('accepted, and its opportunity is dismissed: that is where it is', async () => {
    const s = await setup();
    const existingId = await s.accept(await s.captured());
    await s.stage(existingId, 'dismissed');
    expect(await s.again()).toEqual({ code: 'duplicate', place: 'pipeline', existingId });
  });

  it('accepted, and its opportunity was deleted: in Decided alone', async () => {
    const s = await setup();
    await deleteOpportunity(s.db, s.ctx, await s.accept(await s.captured()));
    expect(await s.again()).toEqual({ code: 'duplicate', place: 'accepted' });
  });

  it('an opportunity made by hand', async () => {
    const s = await setup();
    const opp = await createOpportunity(s.db, s.ctx, {
      companyName: JOB.company,
      title: JOB.title,
      location: JOB.location,
      sourceKind: 'manual',
    });
    expect(await s.again()).toEqual({ code: 'duplicate', place: 'pipeline', existingId: opp.id });
  });

  it('the very posting an opportunity was captured into, under another title', async () => {
    const s = await setup();
    const opp = await createOpportunity(s.db, s.ctx, {
      companyName: JOB.company,
      title: 'Payments Lead',
      location: 'Remote',
      sourceKind: 'manual',
    });
    await createActivity(s.db, s.ctx, opp.id, {
      kind: 'capture',
      title: 'Captured',
      bodyMd: null,
      occurredAt: 1,
      participants: [],
      externalUrl: JOB.postingUrl,
    });
    expect(await s.again()).toEqual({ code: 'duplicate', place: 'pipeline', existingId: opp.id });
  });
});

describe('where it is in more places than one, the liveliest is named (#1053)', () => {
  it('a dismissed result and a card: the queue', async () => {
    const s = await setup();
    const id = await s.captured();
    await s.onBoard();
    await s.dismiss(id);
    expect(await s.again()).toEqual({ code: 'duplicate', place: 'queue' });
  });

  it('a dismissed result and an accepted one: the pipeline', async () => {
    const s = await setup();
    const id = await s.captured();
    const board = await s.onBoard();
    await s.dismiss(id);
    const existingId = await s.accept(board);
    await updateOpportunity(s.db, s.ctx, existingId, { title: 'Head of Payments' });
    expect(await s.again()).toEqual({ code: 'duplicate', place: 'pipeline', existingId });
  });

  it('a card and an accepted one whose opportunity is dismissed: the queue', async () => {
    const s = await setup();
    const existingId = await s.accept(await s.captured());
    await s.stage(existingId, 'dismissed');
    await s.onBoard();
    expect(await s.again()).toEqual({ code: 'duplicate', place: 'queue' });
  });

  it('a card and an accepted one: the pipeline', async () => {
    const s = await setup();
    const existingId = await s.accept(await s.captured());
    await updateOpportunity(s.db, s.ctx, existingId, { title: 'Head of Payments' });
    await s.onBoard();
    expect(await s.again()).toEqual({ code: 'duplicate', place: 'pipeline', existingId });
  });

  it('a dismissed one and an accepted one whose opportunity is dismissed: the pipeline', async () => {
    const s = await setup();
    const id = await s.captured();
    const board = await s.onBoard();
    await s.dismiss(id);
    const existingId = await s.accept(board);
    await s.stage(existingId, 'dismissed');
    expect(await s.again()).toEqual({ code: 'duplicate', place: 'pipeline', existingId });
  });

  it('two accepted ones, each into an opportunity of its own: the oldest', async () => {
    const s = await setup();
    const id = await s.captured();
    const board = await s.onBoard();
    const accepted = await s.accept(id);
    await updateOpportunity(s.db, s.ctx, accepted, { title: 'Head of Payments' });
    const other = await createOpportunity(s.db, s.ctx, {
      companyName: JOB.company,
      title: 'Payments Lead',
      location: 'Remote',
      sourceKind: 'manual',
    });
    await s.db
      .update(discoveryResults)
      .set({ disposition: 'accepted', opportunityId: other.id, createdAt: 1 })
      .where(eq(discoveryResults.id, board))
      .run();
    expect(await s.again()).toEqual({ code: 'duplicate', place: 'pipeline', existingId: other.id });
  });

  it('a dismissed one and an accepted one whose opportunity was deleted: dismissed', async () => {
    const s = await setup();
    const id = await s.captured();
    const board = await s.onBoard();
    await s.dismiss(id);
    await deleteOpportunity(s.db, s.ctx, await s.accept(board));
    expect(await s.again()).toEqual({ code: 'duplicate', place: 'dismissed' });
  });
});

describe('what it is not answered with (#1053)', () => {
  it('another level of the title at the same place: a new card', async () => {
    const s = await setup();
    await s.dismiss(await s.captured());
    expect((await s.capture({ title: 'Principal Platform Engineer' })).statusCode).toBe(201);
  });

  it('another user’s result', async () => {
    const s = await setup();
    const other = ctxOf(s.b);
    const source = await createSource(s.db, other, { kind: 'manual', config: {} });
    const run = await createRun(s.db, other, { sourceId: source.id });
    await insertResult(s.db, other, {
      runId: run.id,
      posting: JOB,
      dedupeKey: KEY,
      resolution: 'full',
    });
    await s.captured();
  });

  it('one that was unsuppressed: a new card', async () => {
    const s = await setup();
    const id = await s.captured();
    await s.dismiss(id);
    const res = await s.a.request({
      method: 'POST',
      url: `/api/v1/discovery/results/${id}/unsuppress`,
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    await s.captured();
  });
});
