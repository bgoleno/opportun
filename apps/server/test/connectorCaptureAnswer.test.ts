// What a job capture answers, so the extension's sentence is true in each case
// (https://github.com/bgoleno/opportun/issues/967, section 4 of tl's design there, and
// https://github.com/bgoleno/opportun/issues/956): whether it made an opportunity, whether it moved
// one, and where the opportunity now is. The four fields installed extensions require are unchanged.
// The provider is mocked and every posting is made up.
import { AiUnavailableError, runStructured } from '@opportun/ai';
import type { OpportunityStage } from '@opportun/core';
import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { opportunities, stageHistory } from '../src/db/schema';
import { setAiCallLimit } from '../src/lib/ai';
import { setRaceHook } from '../src/lib/racePoints';
import {
  createOpportunity,
  getOpportunity,
  transitionOpportunity,
} from '../src/repos/opportunities';
import { useApi } from './api';
import { JOB } from './fixtures/capture/pages';
import type { TestClient } from './isolation';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const boot = useApi();
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

beforeEach(() => {
  vi.mocked(runStructured).mockReset();
  vi.mocked(runStructured).mockRejectedValue(new AiUnavailableError('no_key'));
});

async function device(c: TestClient): Promise<string> {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/device-tokens',
    payload: {
      name: 'Browser extension',
      scopes: ['capture:push'],
      password: 'correct horse battery',
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { token: string }).token;
}

async function push(app: FastifyInstance, bearer: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/connector/capture',
    headers: { authorization: `Bearer ${bearer}` },
    payload: JOB,
  });
  return { status: res.statusCode, body: res.json() };
}

const historyOf = (app: FastifyInstance, id: string) =>
  app.db
    .select({ from: stageHistory.fromStage, to: stageHistory.toStage, note: stageHistory.note })
    .from(stageHistory)
    .where(eq(stageHistory.opportunityId, id))
    .orderBy(asc(stageHistory.at), asc(stageHistory.id))
    .all();

// W7 and the popup's 30 s (tl on #967): the refine had no limit of its own.
describe('POST /connector/capture: the AI refine has 15 s', () => {
  const limitGiven = () =>
    vi.mocked(runStructured).mock.calls.map(([deps]) => deps.callTimeLimitMs);

  it.each([
    ['none set on the instance', undefined, 15_000],
    ['a longer one', 60_000, 15_000],
    ['a shorter one', 4_000, 4_000],
  ])('%s', async (_what, instance, expected) => {
    const { app, a } = await boot();
    if (instance !== undefined) setAiCallLimit(app.db, instance);
    await push(app, await device(a));
    expect(limitGiven()).toEqual([expected]);
  });

  it('past it the capture is stored as without AI', async () => {
    const { app, a } = await boot();
    vi.mocked(runStructured).mockRejectedValue(new AiUnavailableError('provider_error'));
    const { status, body } = await push(app, await device(a));
    expect(status).toBe(201);
    expect(body).toMatchObject({ refined: false, created: true, currentStage: 'interested' });
  });
});

describe('POST /connector/capture: what a job capture answers', () => {
  it('a new one: created, moved to and at Interested, with its history', async () => {
    const { app, a } = await boot();
    const { status, body } = await push(app, await device(a));
    expect(status).toBe(201);
    expect(body).toEqual({
      kind: 'job',
      resultId: expect.any(String),
      duplicate: false,
      refined: false,
      opportunityId: expect.any(String),
      stage: 'interested',
      created: true,
      currentStage: 'interested',
    });
    expect(await historyOf(app, body.opportunityId)).toEqual([
      { from: null, to: 'discovered', note: null },
      { from: 'discovered', to: 'interested', note: 'Captured from the browser extension.' },
    ]);
  });

  it('the same page again: not created, not moved, at Interested, and no second stage entry', async () => {
    const { app, a } = await boot();
    const bearer = await device(a);
    const first = await push(app, bearer);
    const { status, body } = await push(app, bearer);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      opportunityId: first.body.opportunityId,
      resultId: first.body.resultId,
      stage: null,
      created: false,
      currentStage: 'interested',
    });
    expect(await historyOf(app, body.opportunityId)).toHaveLength(2);
  });

  const STAGES: readonly (readonly [OpportunityStage, readonly OpportunityStage[], boolean])[] = [
    ['discovered', [], true],
    ['dismissed', ['dismissed'], true],
    ['interested', ['interested'], false],
    ['preparing', ['interested', 'preparing'], false],
    ['applied', ['interested', 'preparing', 'applied'], false],
    ['in_process', ['interested', 'preparing', 'applied', 'in_process'], false],
    ['offer', ['interested', 'preparing', 'applied', 'in_process', 'offer'], false],
    ['closed', ['closed'], false],
  ];

  it.each(STAGES)('one already tracked at %s', async (stage, path, moves) => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const tracked = await createOpportunity(app.db, ctx, {
      companyName: 'Initech',
      title: 'Staff Platform Engineer',
      sourceKind: 'manual',
    });
    for (const to of path) {
      await transitionOpportunity(app.db, ctx, tracked.id, {
        to,
        ...(to === 'closed' ? { closedReason: 'withdrawn' as const } : {}),
      });
    }
    expect((await getOpportunity(app.db, ctx, tracked.id)).stage).toBe(stage);

    const { status, body } = await push(app, await device(a));

    const after = moves ? 'interested' : stage;
    expect(status).toBe(200);
    expect(body).toMatchObject({
      opportunityId: tracked.id,
      stage: moves ? 'interested' : null,
      created: false,
      currentStage: after,
    });
    expect((await getOpportunity(app.db, ctx, tracked.id)).stage).toBe(after);
    expect(await app.db.select().from(opportunities).all()).toHaveLength(1);
  });

  // #956: the move of a created one used to be a step of its own, skipped when its lock could not be
  // had in time, and the capture then said the job was already tracked.
  describe('when the stage move cannot have its lock', () => {
    const lockTimeout = () =>
      Object.assign(new Error('canceling statement due to lock timeout'), {
        code: '55P03',
        severity: 'ERROR',
      });
    const held = () =>
      setRaceHook(async (point) => {
        if (point === 'captureResolve.advance.locked') throw lockTimeout();
      });

    it('a created one is at Interested all the same, and says so', async () => {
      const { app, a } = await boot();
      const bearer = await device(a);
      held();
      const { status, body } = await push(app, bearer);
      expect(status).toBe(201);
      expect(body).toMatchObject({
        stage: 'interested',
        created: true,
        currentStage: 'interested',
      });
      expect((await getOpportunity(app.db, ctxOf(a), body.opportunityId)).stage).toBe('interested');
    });

    it('one already tracked at New is said to be at New', async () => {
      const { app, a } = await boot();
      const bearer = await device(a);
      const tracked = await createOpportunity(app.db, ctxOf(a), {
        companyName: 'Initech',
        title: 'Staff Platform Engineer',
        sourceKind: 'manual',
      });
      held();
      const { status, body } = await push(app, bearer);
      expect(status).toBe(200);
      expect(body).toMatchObject({
        opportunityId: tracked.id,
        stage: null,
        created: false,
        currentStage: 'discovered',
      });
    });
  });

  it('a capture that fails while it creates leaves no opportunity', async () => {
    const { app, a } = await boot();
    const bearer = await device(a);
    setRaceHook(async (point) => {
      if (point === 'captureResolve.created.locked') throw new Error('broke');
    });
    const { status } = await push(app, bearer);
    expect(status).toBe(500);
    expect(await app.db.select().from(opportunities).all()).toEqual([]);
    expect(await app.db.select().from(stageHistory).all()).toEqual([]);
  });
});
