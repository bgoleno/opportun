// A later try of a message against what else can happen to it meanwhile, each order forced
// (https://github.com/bgoleno/opportun/issues/1050, tl's table and sec's condition on
// applyClassification): nothing is classified twice, and what the user did stands, with nothing made of
// the refused result. Every message is made up.
import { randomBytes } from 'node:crypto';
import { AiUnavailableError, runStructured } from '@opportun/ai';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activities,
  communications,
  dismissalFeedback,
  jobs,
  opportunities,
  stageHistory,
} from '../src/db/schema';
import { DEMO_USERS } from '../src/lib/demo/fixture';
import { DEMO_SEED_ACK_KEY } from '../src/lib/demo/seed';
import { currentHoldStop, DemoResetGate, HOLD_LIMIT_MS } from '../src/lib/demoResetGate';
import { CLASSIFY_JOB_KIND, CLASSIFY_WAITING_KIND } from '../src/lib/mailClassifyQueue';
import { setRaceHook } from '../src/lib/racePoints';
import { backfillClassify } from '../src/jobs/classifyBackfill';
import { enqueueClassifyWaiting } from '../src/jobs/classifyWaiting';
import { runDemoResetGated } from '../src/jobs/demoReset';
import { ingestInbound } from '../src/jobs/mailIngest';
import { beginClassifyTry } from '../src/repos/classifyWait';
import { applyClassification, reclassify } from '../src/repos/communications';
import { rejectCommunication } from '../src/repos/reject';
import { useApi } from './api';
import {
  classifier,
  ctxOf,
  drain,
  FOLLOW_UP,
  jobsOf,
  NOW,
  onlySchedule,
  rowOf,
  shown,
  stored,
  TARGETED,
  waitOf,
} from './classifyWaitingFixtures';
import { testApp } from './helpers';
import type { TestClient } from './isolation';
import { heldApart, holdAt, pauseAt, whileParked } from './race';
import { runQueuedJob } from './runQueuedJob';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const bootApp = useApi();
async function boot() {
  const env = await bootApp();
  await onlySchedule(env.app, null);
  return env;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'], shouldAdvanceTime: true });
  vi.mocked(runStructured).mockReset();
  classifier(() => TARGETED);
});
afterEach(() => {
  vi.useRealTimers();
  setRaceHook(undefined);
});

/** What a classification makes, beside its row. */
async function made(app: FastifyInstance) {
  const count = async (rows: Promise<unknown[]>) => (await rows).length;
  return {
    opportunities: await count(app.db.select().from(opportunities).all()),
    activities: await count(app.db.select().from(activities).all()),
    feedback: await count(app.db.select().from(dismissalFeedback).all()),
    stages: await count(app.db.select().from(stageHistory).all()),
    enrich: await count(jobsOf(app, 'opportunity.enrich')),
  };
}

interface Act {
  name: string;
  act: (app: FastifyInstance, c: TestClient, id: string) => Promise<unknown>;
  /** The row as it leaves it. */
  row: Record<string, unknown>;
  /** The point inside its transaction, after its lock. */
  locked: string;
}
const ACTS: Act[] = [
  {
    name: 'a reject',
    act: async (app, c, id) =>
      rejectCommunication(app.db, ctxOf(c), id, {
        reason: 'not_job_related',
        expectedOpportunityId: (await rowOf(app, id)).opportunityId,
      }),
    row: {
      classification: null,
      rejectionReason: 'not_job_related',
      opportunityId: null,
      proposedTransition: null,
      confidence: null,
      classifyWait: null,
      classifyTriedAt: null,
    },
    locked: 'reject.erased',
  },
  {
    name: 'the user’s correction',
    act: (app, c, id) => reclassify(app.db, ctxOf(c), id, { classification: 'networking' }),
    row: {
      classification: 'networking',
      rejectedAt: null,
      outreachKind: null,
      opportunityId: null,
      classifyWait: null,
      classifyTriedAt: null,
    },
    locked: 'reclassify.read',
  },
];

describe.each(ACTS)('$name, against a later try', ({ act, row, locked }) => {
  /** The act, and what it makes itself: whatever comes after must add nothing to it. */
  async function acts(app: FastifyInstance, c: TestClient, id: string) {
    await act(app, c, id);
    return { made: await made(app), row: await rowOf(app, id) };
  }
  async function stands(app: FastifyInstance, id: string, was: Awaited<ReturnType<typeof acts>>) {
    expect(await rowOf(app, id)).toMatchObject(row);
    expect(await rowOf(app, id)).toEqual(was.row);
    expect(await made(app)).toEqual(was.made);
  }

  it('after the list is read: it is not tried', async () => {
    const { app, a } = await boot();
    await stored(app, a, { subject: 'first', sentAt: NOW });
    const id = await stored(app, a, { subject: 'second', sentAt: NOW - 1 });
    let was!: Awaited<ReturnType<typeof acts>>;
    classifier(async () => {
      was = await acts(app, a, id);
      return FOLLOW_UP;
    });
    expect(await drain(app, a)).toEqual({ classified: 1, left: 0, stopped: null });
    expect(shown()).toHaveLength(1);
    await stands(app, id, was);
  });

  it('between the read and the write that begins it: it is not tried', async () => {
    const { app, a } = await boot();
    const id = await stored(app, a);
    const pause = pauseAt('classifyWaiting.read');
    const tried = drain(app, a);
    const was = await whileParked(pause, () => acts(app, a, id));
    expect(await tried).toEqual({ classified: 0, left: 0, stopped: null });
    expect(shown()).toEqual([]);
    await stands(app, id, was);
  });

  it('once it has begun, before its turn’s read: nothing is sent', async () => {
    const { app, a } = await boot();
    const id = await stored(app, a);
    const pause = pauseAt('classifyWaiting.begun');
    const tried = drain(app, a);
    const was = await whileParked(pause, () => acts(app, a, id));
    expect(await tried).toEqual({ classified: 0, left: 1, stopped: null });
    expect(shown()).toEqual([]);
    await stands(app, id, was);
  });

  it.each(['classify.call', 'classify.apply.read'])(
    'after its turn’s read (%s): nothing is applied',
    async (point) => {
      const { app, a } = await boot();
      const id = await stored(app, a);
      const pause = pauseAt(point);
      const tried = drain(app, a);
      const was = await whileParked(pause, () => acts(app, a, id));
      expect(await tried).toEqual({ classified: 0, left: 1, stopped: null });
      expect(shown()).toHaveLength(1);
      await stands(app, id, was);
    },
  );

  it('during the call: nothing is applied', async () => {
    const { app, a } = await boot();
    const id = await stored(app, a);
    let was!: Awaited<ReturnType<typeof acts>>;
    classifier(async () => {
      was = await acts(app, a, id);
      return TARGETED;
    });
    expect(await drain(app, a)).toEqual({ classified: 0, left: 1, stopped: null });
    await stands(app, id, was);
  });

  it.each([
    ['a spent budget', new AiUnavailableError('budget_exceeded')],
    ['no key', new AiUnavailableError('no_key')],
    ['a refused key', new AiUnavailableError('provider_error', '', { keyRejected: true })],
    ['an outage', new AiUnavailableError('provider_error')],
    ['an unusable answer', new AiUnavailableError('invalid_output')],
    ['a defect', new Error('a defect')],
  ] as [string, Error][])('during a call that ends in %s: no wait is set', async (_n, err) => {
    const { app, a } = await boot();
    const id = await stored(app, a);
    let was!: Awaited<ReturnType<typeof acts>>;
    classifier(async () => {
      was = await acts(app, a, id);
      throw err;
    });
    await drain(app, a);
    expect(shown()).toHaveLength(1);
    await stands(app, id, was);
  });

  it('its lock held, the result waits for it, and is not applied', async () => {
    const { app, a } = await boot();
    const id = await stored(app, a);
    const [, applied] = await heldApart(
      app,
      locked,
      () => act(app, a, id),
      () => applyClassification(app.db, ctxOf(a), id, TARGETED, 'snippet'),
    );
    expect(applied).toBeNull();
    const was = { made: await made(app), row: await rowOf(app, id) };
    expect(was.made).toMatchObject({ opportunities: 0, activities: 0, enrich: 0 });
    await stands(app, id, was);
  });

  it('the result’s lock held, it waits for it, and then it is the one that stands', async () => {
    const { app, a } = await boot();
    const id = await stored(app, a);
    const [tried] = await heldApart(
      app,
      'classify.apply.locked',
      () => drain(app, a),
      async () => {
        // As the page saw it: not linked yet. A reject of what is linked since asks again, so what
        // the user sees then is the message as classified.
        try {
          await act(app, a, id);
        } catch (err) {
          expect((err as { statusCode?: number }).statusCode).toBe(409);
          await act(app, a, id);
        }
      },
    );
    expect(tried).toEqual({ classified: 1, left: 0, stopped: null });
    const after = { ...row };
    // A link it made is the act's to keep.
    delete after['opportunityId'];
    expect(await rowOf(app, id)).toMatchObject(after);
  });

  it('after it: as on any classified message', async () => {
    const { app, a } = await boot();
    const id = await stored(app, a);
    await drain(app, a);
    expect((await rowOf(app, id)).classification).toBe('solicitation');
    await act(app, a, id);
    const after = { ...row };
    // A link it made is the act's to keep.
    delete after['opportunityId'];
    expect(await rowOf(app, id)).toMatchObject(after);
    await drain(app, a);
    expect(shown()).toHaveLength(1);
  });

  it('a first job’s result is refused too', async () => {
    const { app, a } = await boot();
    const id = await stored(app, a, { wait: null });
    const was = await acts(app, a, id);
    expect(await applyClassification(app.db, ctxOf(a), id, TARGETED, 'payload')).toBeNull();
    await stands(app, id, was);
  });
});

it('a result for a message both classified and rejected says rejected, and touches nothing', async () => {
  const { app, a } = await boot();
  const id = await stored(app, a);
  await reclassify(app.db, ctxOf(a), id, { classification: 'networking' });
  await app.db
    .update(communications)
    .set({ rejectedAt: NOW })
    .where(eq(communications.id, id))
    .run();
  const before = await rowOf(app, id);
  expect(await applyClassification(app.db, ctxOf(a), id, TARGETED, 'snippet')).toBeNull();
  expect(await rowOf(app, id)).toEqual(before);
  expect(await made(app)).toMatchObject({ opportunities: 0, enrich: 0 });
});

describe('the same message arrives again', () => {
  const EXT = 'apple-mail:again@mail.example';
  const again = (app: FastifyInstance, c: TestClient) =>
    ingestInbound(app.db, ctxOf(c), app.storage, 'apple_mail', {
      externalId: EXT,
      threadKey: 'again',
      from: 'Riley Recruiter <riley@initech.example>',
      to: ['me@example.com'],
      subject: 'Your application',
      snippet: 'Thank you for applying.',
      bodyText: 'Thank you for applying to the Staff Engineer role. The whole of it.',
      sentAt: NOW,
    });
  /** Its first job met a spent budget, and is over. */
  async function waiting(app: FastifyInstance, c: TestClient): Promise<string> {
    classifier(() => {
      throw new AiUnavailableError('budget_exceeded');
    });
    const { id } = await again(app, c);
    await app.jobs.drain();
    expect(await waitOf(app, id)).toBe('budget_exceeded');
    vi.mocked(runStructured).mockClear();
    classifier(() => FOLLOW_UP);
    return id;
  }
  const classifyJobs = (app: FastifyInstance) => jobsOf(app, CLASSIFY_JOB_KIND);
  const prune = (app: FastifyInstance) =>
    app.db.delete(jobs).where(eq(jobs.kind, CLASSIFY_JOB_KIND)).run();

  describe.each([
    ['its first job’s row kept', false],
    ['its first job’s row pruned', true],
  ])('%s', (_name, pruned) => {
    it.each([
      'classifyWaiting.read',
      'classifyWaiting.begun',
      'classify.call',
      'classify.apply.read',
    ])('at %s: no job, one call, classified once', async (point) => {
      const { app, a } = await boot();
      const id = await waiting(app, a);
      if (pruned) await prune(app);
      const had = (await classifyJobs(app)).length;
      const pause = pauseAt(point);
      const tried = drain(app, a);
      await whileParked(pause, async () => {
        expect(await again(app, a)).toMatchObject({ id, inserted: false });
      });
      expect(await tried).toEqual({ classified: 1, left: 0, stopped: null });
      expect(await classifyJobs(app)).toHaveLength(had);
      expect(shown()).toHaveLength(1);
      // The text it arrived with is not read: the row stays as it was stored (#1038).
      expect(await rowOf(app, id)).toMatchObject({
        classification: 'follow_up',
        bodySource: 'snippet',
      });
    });

    it.each([
      'budget_exceeded',
      'failed',
      'trying',
      'key_rejected',
      'no_key',
      'invalid_output',
      'blocked',
    ] as const)('while it says %s, and after it is classified: no job', async (wait) => {
      const { app, a } = await boot();
      const id = await waiting(app, a);
      if (pruned) await prune(app);
      await app.db
        .update(communications)
        .set({ classifyWait: wait })
        .where(eq(communications.id, id))
        .run();
      const had = (await classifyJobs(app)).length;
      await again(app, a);
      expect(await classifyJobs(app)).toHaveLength(had);
      await app.db
        .update(communications)
        .set({ classifyWait: null, classification: 'other' })
        .where(eq(communications.id, id))
        .run();
      await again(app, a);
      expect(await classifyJobs(app)).toHaveLength(had);
    });
  });

  it('one whose first job was lost is routed, as before', async () => {
    const { app, a } = await boot();
    const id = await waiting(app, a);
    await prune(app);
    await app.db
      .update(communications)
      .set({ classifyWait: null })
      .where(eq(communications.id, id))
      .run();
    await again(app, a);
    expect(await classifyJobs(app)).toHaveLength(1);
  });
});

describe('a new key’s backfill, and another drain', () => {
  it.each([
    'classifyWaiting.read',
    'classifyWaiting.begun',
    'classify.call',
    'classify.apply.read',
  ])('the backfill at %s: no second job, one call', async (point) => {
    const { app, a } = await boot();
    const id = await stored(app, a);
    const pause = pauseAt(point);
    const tried = drain(app, a);
    await whileParked(pause, async () => {
      expect(await backfillClassify(app.db, ctxOf(a))).toBe(0);
    });
    expect((await tried).classified).toBe(1);
    expect(shown()).toHaveLength(1);
    expect((await rowOf(app, id)).classification).toBe('solicitation');
  });

  it('two drains that both read a message as waiting: one tries it', async () => {
    const { app, a } = await boot();
    const id = await stored(app, a);
    const both = holdAt('classifyWaiting.read', 2);
    const begun = await Promise.all([
      beginClassifyTry(app.db, ctxOf(a), id, Date.now()),
      beginClassifyTry(app.db, ctxOf(a), id, Date.now()),
    ]);
    expect(both.arrived()).toBe(2);
    expect(begun.filter((b) => b !== null)).toEqual(['budget_exceeded']);
  });

  it('its job queued since the list was read: not tried beside it', async () => {
    const { app, a } = await boot();
    const id = await stored(app, a);
    const pause = pauseAt('classifyWaiting.read');
    const tried = drain(app, a);
    await whileParked(pause, async () => {
      await app.db
        .insert(jobs)
        .values({
          id: 'a-queued-job',
          kind: CLASSIFY_JOB_KIND,
          payload: { communicationId: id },
          userId: a.userId,
          status: 'pending',
          runAt: NOW,
          attempts: 0,
          maxAttempts: 3,
          dedupeKey: `${CLASSIFY_JOB_KIND}:${id}`,
          createdAt: NOW,
          updatedAt: NOW,
        })
        .run();
    });
    expect(await tried).toEqual({ classified: 0, left: 0, stopped: null });
    expect(shown()).toEqual([]);
  });
});

describe('on a demo server', () => {
  it('a shared account’s drain holds the reset’s gate, and ends with its hold', async () => {
    const { app, dataDir } = await testApp({ demo: true });
    try {
      const env: NodeJS.ProcessEnv = {
        OPPORTUN_MASTER_KEY: randomBytes(32).toString('hex'),
        OPPORTUN_BASE_URL: 'https://demo.example.com',
        DATA_DIR: dataDir,
        OPPORTUN_DEMO: '1',
        [DEMO_SEED_ACK_KEY]: '1',
        OPPORTUN_DEMO_ADMIN_PASSWORD: 'demo-admin-password-1',
        OPPORTUN_DEMO_USER1_PASSWORD: 'demo-user1-password-1',
        OPPORTUN_DEMO_USER2_PASSWORD: 'demo-user2-password-1',
        OPPORTUN_DEMO_USER3_PASSWORD: 'demo-user3-password-1',
        OPPORTUN_DEMO_USER4_PASSWORD: 'demo-user4-password-1',
        OPPORTUN_DEMO_AI_KEY: 'sk-ant-made-up-demo-key-0123456789',
      };
      await runDemoResetGated(app.db, env, undefined);
      await onlySchedule(app, null);
      vi.useRealTimers();
      const user = { userId: DEMO_USERS[1]!.id } as TestClient;
      const sentAt = Date.now();
      const ids = [
        await stored(app, user, { sentAt }),
        await stored(app, user, { sentAt: sentAt - 1 }),
      ];
      // The stop comes 50 ms into the hold, its bound 50 s in.
      const gate = new DemoResetGate({ stopMarginMs: HOLD_LIMIT_MS - 50 });
      const held: number[] = [];
      classifier(async () => {
        const stop = currentHoldStop();
        expect(stop).toBeInstanceOf(AbortSignal);
        await new Promise<void>((r) => {
          if (stop!.aborted) r();
          stop!.addEventListener('abort', () => r());
        });
        held.push(gate.held);
        throw new AiUnavailableError('provider_error', 'aborted');
      });
      const id = await enqueueClassifyWaiting(app.db, { userId: user.userId, isAdmin: false });
      await runQueuedJob(app, id, { services: { ...app.jobs.services, demoResetGate: gate } });
      expect(held).toEqual([1]);
      expect(gate.held).toBe(0);
      const [job] = await jobsOf(app, CLASSIFY_WAITING_KIND);
      expect(job).toMatchObject({ status: 'done', result: { classified: 0, stopped: 'shutdown' } });
      expect(await Promise.all(ids.map((i) => waitOf(app, i)))).toEqual([
        'provider_error',
        'budget_exceeded',
      ]);
    } finally {
      app.server.closeAllConnections();
      await app.close();
    }
  });
});
