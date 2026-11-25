// Which unclassified messages wait, what a later try of them does, and what stops it
// (https://github.com/bgoleno/opportun/issues/1050; tl's design and sec's conditions there). What a
// later try reads is in classifyWaitingText.test.ts, its races in classifyWaitingRaces.test.ts.
import { AiUnavailableError, runStructured } from '@opportun/ai';
import type { ClassifyWait } from '@opportun/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { communications, jobs, prompts } from '../src/db/schema';
import {
  backfillClassify,
  CLASSIFY_BACKFILL_KIND,
  enqueueClassifyBackfill,
} from '../src/jobs/classifyBackfill';
import {
  CLASSIFY_WAITING_SWEEP_KIND,
  resumeClassifyAfterKeyChange,
  sweepWaitingMessages,
} from '../src/jobs/classifyWaiting';
import { ingestInbound } from '../src/jobs/mailIngest';
import { DEFAULT_KIND_LIMITS, recoverStaleJobs, startRunner } from '../src/jobs/runner';
import { budgetKey, writeSetting } from '../src/lib/ai';
import { enqueue, readSchedules } from '../src/lib/jobQueue';
import {
  CLASSIFY_JOB_KIND,
  CLASSIFY_WAITING_KIND,
  classifyDedupeKey,
} from '../src/lib/mailClassifyQueue';
import { setRaceHook } from '../src/lib/racePoints';
import {
  beginClassifyTry,
  CLASSIFY_WAIT_DAYS,
  listWaitingMessageIds,
  setClassifyWait,
} from '../src/repos/classifyWait';
import { reclassify } from '../src/repos/communications';
import { readKeyChangedAt } from '../src/repos/discoveryBudget';
import { rejectCommunication } from '../src/repos/reject';
import { useApi } from './api';
import {
  asked,
  classifier,
  ctxOf,
  DAY,
  drain,
  drainsQueued,
  FOLLOW_UP,
  HOUR,
  jobsOf,
  MINUTE,
  NOW,
  onlySchedule,
  rowOf,
  shown,
  spend,
  stored,
  TOMORROW,
  waitOf,
} from './classifyWaitingFixtures';
import type { TestClient } from './isolation';
import { heldApart } from './race';

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
  classifier(() => FOLLOW_UP);
});
afterEach(() => {
  vi.useRealTimers();
  setRaceHook(undefined);
});

const refused = () =>
  new AiUnavailableError('provider_error', 'the provider answered HTTP 401', { keyRejected: true });
const fails = (err: unknown) =>
  classifier(() => {
    throw err;
  });

let seq = 0;
/** A new message with its first job queued, its text in it. */
async function arrives(app: FastifyInstance, c: TestClient, subject?: string): Promise<string> {
  seq += 1;
  const { id } = await ingestInbound(app.db, ctxOf(c), app.storage, 'apple_mail', {
    externalId: `apple-mail:first-${seq}@mail.example`,
    threadKey: `first-${seq}`,
    from: 'Riley Recruiter <riley@initech.example>',
    to: ['me@example.com'],
    subject: subject ?? `Your application ${seq}`,
    snippet: 'Thank you for applying to the Staff Engineer role.',
    bodyText: 'Thank you for applying to the Staff Engineer role. The whole text.',
    sentAt: NOW - seq * MINUTE,
  });
  return id;
}
const firstJob = async (app: FastifyInstance, id: string) =>
  (
    await app.db
      .select()
      .from(jobs)
      .where(eq(jobs.dedupeKey, classifyDedupeKey(id)))
      .all()
  )[0]!;
/** The queue runs now, and again after each of the runner's waits. */
async function runTries(app: FastifyInstance): Promise<void> {
  await app.jobs.drain();
  for (let i = 0; i < 5; i += 1) {
    vi.setSystemTime(Date.now() + 5 * MINUTE);
    await app.jobs.drain();
  }
}

describe('how a first job ends', () => {
  it.each([
    ['a spent budget', new AiUnavailableError('budget_exceeded'), 1, 'budget_exceeded'],
    ['an outage', new AiUnavailableError('provider_error', 'out'), 3, 'provider_error'],
    ['an unusable answer', new AiUnavailableError('invalid_output'), 3, 'invalid_output'],
    ['no key', new AiUnavailableError('no_key'), 1, 'no_key'],
    ['a refused key', refused(), 1, 'key_rejected'],
  ] as [string, AiUnavailableError, number, ClassifyWait][])(
    '%s: done, its text gone, and the row says why',
    async (_name, err, calls, wait) => {
      const { app, a } = await boot();
      fails(err);
      const id = await arrives(app, a);
      await runTries(app);
      expect(shown()).toHaveLength(calls);
      expect(await firstJob(app, id)).toMatchObject({
        status: 'done',
        payload: { communicationId: id },
        result: { status: 'skipped', reason: wait },
      });
      expect(await rowOf(app, id)).toMatchObject({
        classification: null,
        classifyWait: wait,
        classifyTriedAt: null,
      });
    },
  );

  it('an outage that ends within its tries: classified, and nothing is said', async () => {
    const { app, a } = await boot();
    classifier(() => {
      if (shown().length < 3) throw new AiUnavailableError('provider_error', 'out');
      return FOLLOW_UP;
    });
    const id = await arrives(app, a);
    await runTries(app);
    expect(await rowOf(app, id)).toMatchObject({
      classification: 'follow_up',
      classifyWait: null,
      bodySource: 'payload',
    });
  });

  it('anything else: dead, and the row says it failed', async () => {
    const { app, a } = await boot();
    fails(new Error('a defect'));
    const id = await arrives(app, a);
    await runTries(app);
    expect((await firstJob(app, id)).status).toBe('dead');
    expect(await waitOf(app, id)).toBe('failed');
  });

  it('its process ended at each try: the same', async () => {
    const { app, a } = await boot();
    const id = await arrives(app, a);
    await app.db
      .update(jobs)
      .set({ status: 'running', attempts: 3, lockedBy: 'gone', lockedAt: NOW })
      .where(eq(jobs.dedupeKey, classifyDedupeKey(id)))
      .run();
    await recoverStaleJobs(app.db);
    expect((await firstJob(app, id)).status).toBe('dead');
    expect(await waitOf(app, id)).toBe('failed');
  });

  it('a job that dies leaves a reason the row has', async () => {
    const { app, a } = await boot();
    fails(new Error('a defect'));
    const id = await arrives(app, a);
    await setClassifyWait(app.db, ctxOf(a), id, 'blocked');
    await runTries(app);
    expect(await waitOf(app, id)).toBe('blocked');
  });

  it('nothing else is said of one that is blocked', async () => {
    const { app, a } = await boot();
    fails(new AiUnavailableError('budget_exceeded'));
    const id = await arrives(app, a);
    await setClassifyWait(app.db, ctxOf(a), id, 'blocked');
    await app.jobs.drain();
    expect((await firstJob(app, id)).result).toMatchObject({ reason: 'budget_exceeded' });
    expect(await waitOf(app, id)).toBe('blocked');
  });

  it('ten first jobs of a user whose key is refused: one call, and all ten say so', async () => {
    const { app, a, b } = await boot();
    fails(refused());
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) ids.push(await arrives(app, a));
    const other = await arrives(app, b, 'Your application: another user');
    await runTries(app);
    expect(asked().filter((s) => s !== 'Your application: another user')).toHaveLength(1);
    for (const id of ids) {
      expect(await waitOf(app, id)).toBe('key_rejected');
      expect((await firstJob(app, id)).payload).toEqual({ communicationId: id });
    }
    // The stop is the user's own: this one's call was made.
    expect(asked()).toContain('Your application: another user');
    expect(await waitOf(app, other)).toBe('key_rejected');
  });

  it('one that came over 30 days ago stops them too', async () => {
    const { app, a } = await boot();
    await stored(app, a, { wait: 'key_rejected', createdAt: NOW - 31 * DAY });
    const id = await arrives(app, a);
    await app.jobs.drain();
    expect(shown()).toEqual([]);
    expect(await waitOf(app, id)).toBe('key_rejected');
  });

  it('one that is classified since stops nothing, whatever is left in its row', async () => {
    const { app, a } = await boot();
    const done = await stored(app, a, { wait: 'key_rejected' });
    await app.db
      .update(communications)
      .set({ classification: 'other' })
      .where(eq(communications.id, done))
      .run();
    const id = await arrives(app, a);
    await app.jobs.drain();
    expect((await rowOf(app, id)).classification).toBe('follow_up');
  });
});

describe('which messages wait', () => {
  it.each([
    ['budget_exceeded', true],
    ['provider_error', true],
    ['failed', true],
    ['key_rejected', false],
    ['no_key', false],
    ['invalid_output', false],
    ['blocked', false],
    ['trying', false],
    [null, false],
  ] as [ClassifyWait | null, boolean][])('%s: %s', async (wait, waits) => {
    const { app, a } = await boot();
    const id = await stored(app, a, { wait, triedAt: wait === 'trying' ? NOW - 1 : null });
    expect(await listWaitingMessageIds(app.db, ctxOf(a))).toEqual(waits ? [id] : []);
    const begun = await beginClassifyTry(app.db, ctxOf(a), id, Date.now());
    expect(begun).toBe(waits ? wait : null);
    expect(await waitOf(app, id)).toBe(waits ? 'trying' : wait);
  });

  const gone: [string, (app: FastifyInstance, c: TestClient, id: string) => Promise<unknown>][] = [
    [
      'classified',
      (app, _c, id) =>
        app.db
          .update(communications)
          .set({ classification: 'other' })
          .where(eq(communications.id, id))
          .run(),
    ],
    [
      'rejected',
      (app, _c, id) =>
        app.db
          .update(communications)
          .set({ rejectedAt: NOW })
          .where(eq(communications.id, id))
          .run(),
    ],
    [
      'filtered',
      (app, _c, id) =>
        app.db
          .update(communications)
          .set({ triageDecision: 'filtered' })
          .where(eq(communications.id, id))
          .run(),
    ],
    [
      'received more than 30 days ago',
      (app, _c, id) =>
        app.db
          .update(communications)
          .set({ createdAt: NOW - CLASSIFY_WAIT_DAYS * DAY - 1 })
          .where(eq(communications.id, id))
          .run(),
    ],
    [
      'its job not over',
      (app, c, id) =>
        enqueue(
          app.db,
          CLASSIFY_JOB_KIND,
          { communicationId: id },
          { dedupeKey: classifyDedupeKey(id), userId: c.userId },
        ),
    ],
    [
      'its job running',
      async (app, c, id) => {
        await enqueue(
          app.db,
          CLASSIFY_JOB_KIND,
          { communicationId: id },
          { dedupeKey: classifyDedupeKey(id), userId: c.userId },
        );
        await app.db.update(jobs).set({ status: 'running' }).run();
      },
    ],
  ];
  it.each(gone)('not one that is %s, whatever it says', async (_name, make) => {
    const { app, a } = await boot();
    const id = await stored(app, a);
    await make(app, a, id);
    vi.setSystemTime(NOW);
    expect(await listWaitingMessageIds(app.db, ctxOf(a), NOW)).toEqual([]);
    expect(await beginClassifyTry(app.db, ctxOf(a), id, NOW)).toBeNull();
    expect(await sweepWaitingMessages(app.db)).toEqual({ queued: 0 });
    await drain(app, a);
    expect(shown()).toEqual([]);
  });

  it.each(['done', 'dead'] as const)('one whose job is %s waits', async (status) => {
    const { app, a } = await boot();
    const id = await stored(app, a);
    await enqueue(
      app.db,
      CLASSIFY_JOB_KIND,
      { communicationId: id },
      { dedupeKey: classifyDedupeKey(id), userId: a.userId },
    );
    await app.db.update(jobs).set({ status }).run();
    expect(await listWaitingMessageIds(app.db, ctxOf(a))).toEqual([id]);
  });

  it('30 days to the millisecond still do', async () => {
    const { app, a } = await boot();
    const id = await stored(app, a, { createdAt: NOW - CLASSIFY_WAIT_DAYS * DAY });
    expect(await listWaitingMessageIds(app.db, ctxOf(a), NOW)).toEqual([id]);
  });

  it('another user’s messages are theirs alone', async () => {
    const { app, a, b } = await boot();
    const id = await stored(app, a);
    expect(await listWaitingMessageIds(app.db, ctxOf(b))).toEqual([]);
    expect(await beginClassifyTry(app.db, ctxOf(b), id, Date.now())).toBeNull();
    expect(await setClassifyWait(app.db, ctxOf(b), id, 'blocked')).toBe(false);
    expect(await waitOf(app, id)).toBe('budget_exceeded');
    await drain(app, b);
    expect(shown()).toEqual([]);
  });

  it('newest sent first, and those tried today behind the others', async () => {
    const { app, a } = await boot();
    const at = (subject: string, sentAt: number, triedAt?: number) =>
      stored(app, a, { subject, sentAt, ...(triedAt === undefined ? {} : { triedAt }) });
    await at('old', NOW - 5 * DAY);
    await at('newest, tried today', NOW - HOUR, NOW - MINUTE);
    await at('new', NOW - DAY);
    await at('newer, tried yesterday', NOW - 2 * HOUR, NOW - DAY);
    await at('older, tried today', NOW - 3 * DAY, NOW - MINUTE);
    await drain(app, a);
    expect(asked()).toEqual([
      'newer, tried yesterday',
      'new',
      'old',
      'newest, tried today',
      'older, tried today',
    ]);
  });
});

describe('the sweep and the drain', () => {
  it('runs every hour, on a minute of its own', async () => {
    const { app } = await bootApp();
    const sweep = (await readSchedules(app.db)).find((s) => s.kind === CLASSIFY_WAITING_SWEEP_KIND);
    expect(sweep?.schedule?.cron).toBe('35 * * * *');
    expect(sweep?.userId).toBeNull();
  });

  it('queues one drain a user who has room, and no second beside it', async () => {
    const { app, a, b } = await boot();
    await stored(app, a);
    await stored(app, a);
    await stored(app, b);
    await spend(app, b, 2.5);
    expect(await sweepWaitingMessages(app.db)).toEqual({ queued: 1 });
    await sweepWaitingMessages(app.db);
    expect(await drainsQueued(app, a)).toBe(1);
    expect(await drainsQueued(app, b)).toBe(0);
  });

  it('classifies what waits, and clears both columns', async () => {
    const { app, a } = await boot();
    const id = await stored(app, a);
    await stored(app, a);
    await sweepWaitingMessages(app.db);
    await app.jobs.drain();
    const [job] = await jobsOf(app, CLASSIFY_WAITING_KIND);
    expect(job).toMatchObject({
      status: 'done',
      userId: a.userId,
      result: { classified: 2, left: 0, stopped: null },
    });
    expect(await rowOf(app, id)).toMatchObject({
      classification: 'follow_up',
      classifyWait: null,
      classifyTriedAt: null,
      bodySource: 'snippet',
    });
    expect(await drain(app, a)).toEqual({ classified: 0, left: 0, stopped: null });
  });

  it('begins no call from half of the day’s budget for it, and goes on the next day', async () => {
    const { app, a } = await boot();
    for (let i = 1; i <= 5; i += 1)
      await stored(app, a, { subject: `M${i}`, sentAt: NOW - i * HOUR });
    // New mail has spent 1.60 of the 5.00; each call is 0.40.
    await spend(app, a, 1.6);
    // Nor what is not mail's, nor yesterday's.
    await spend(app, a, 4, { taskKey: 'discovery.rank' });
    await spend(app, a, 4, { at: NOW - DAY });
    classifier(async () => {
      await spend(app, a, 0.4);
      return FOLLOW_UP;
    });
    // 1.60, 2.00 and 2.40 are under 2.50; 2.80 is not.
    expect(await drain(app, a)).toEqual({ classified: 3, left: 0, stopped: 'no_room' });
    expect(asked()).toEqual(['M1', 'M2', 'M3']);
    expect(await sweepWaitingMessages(app.db)).toEqual({ queued: 0 });
    // A new message's own job has no such limit.
    const id = await arrives(app, a, 'Your application: today');
    await app.jobs.drain();
    expect((await rowOf(app, id)).classification).toBe('follow_up');

    vi.setSystemTime(TOMORROW + MINUTE);
    expect(await sweepWaitingMessages(app.db)).toEqual({ queued: 1 });
    await app.jobs.drain();
    expect(asked()).toEqual(['M1', 'M2', 'M3', 'Your application: today', 'M4', 'M5']);
  });

  it('at exactly half there is no room', async () => {
    const { app, a } = await boot();
    await stored(app, a);
    await spend(app, a, 2.5);
    expect((await drain(app, a)).stopped).toBe('no_room');
    expect(shown()).toEqual([]);
  });

  it('half of the user’s own setting', async () => {
    const { app, a } = await boot();
    await stored(app, a);
    await writeSetting(app.db, ctxOf(a), budgetKey(a.userId), { perTaskDailyUsd: 1 });
    await spend(app, a, 0.5);
    expect((await drain(app, a)).stopped).toBe('no_room');
  });

  it.each([
    ['budget_exceeded', new AiUnavailableError('budget_exceeded')],
    ['no_key', new AiUnavailableError('no_key')],
    ['key_rejected', refused()],
  ] as const)('%s stops it at the first, which says so', async (reason, err) => {
    const { app, a } = await boot();
    const first = await stored(app, a);
    const second = await stored(app, a);
    fails(err);
    expect(await drain(app, a)).toEqual({ classified: 0, left: 1, stopped: reason });
    expect(shown()).toHaveLength(1);
    expect(await waitOf(app, first)).toBe(reason);
    expect(await waitOf(app, second)).toBe('budget_exceeded');
  });

  it('three errors of the provider in a row stop it; each message still waits', async () => {
    const { app, a } = await boot();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await stored(app, a));
    fails(new AiUnavailableError('provider_error', 'out'));
    expect(await drain(app, a)).toEqual({ classified: 0, left: 3, stopped: 'provider_error' });
    expect(shown()).toHaveLength(3);
    expect(await Promise.all(ids.map((id) => waitOf(app, id)))).toEqual([
      'provider_error',
      'provider_error',
      'provider_error',
      'budget_exceeded',
      'budget_exceeded',
    ]);
    expect((await listWaitingMessageIds(app.db, ctxOf(a))).sort()).toEqual([...ids].sort());
  });

  it.each([
    ['a classification', () => FOLLOW_UP],
    [
      'an unusable answer',
      () => {
        throw new AiUnavailableError('invalid_output');
      },
    ],
  ] as [string, () => unknown][])('%s between them starts the count again', async (_n, third) => {
    const { app, a } = await boot();
    for (let i = 0; i < 5; i += 1) await stored(app, a);
    classifier(() => {
      if (shown().length === 3) return third();
      throw new AiUnavailableError('provider_error', 'out');
    });
    expect((await drain(app, a)).stopped).toBeNull();
    expect(shown()).toHaveLength(5);
  });

  it('one that throws says it failed, and those behind it go on', async () => {
    const { app, a } = await boot();
    const bad = await stored(app, a, { subject: 'bad' });
    const good = await stored(app, a, { subject: 'good' });
    classifier((system) => {
      if (system.includes('Subject: bad')) throw new Error('a defect');
      return FOLLOW_UP;
    });
    expect(await drain(app, a)).toEqual({ classified: 1, left: 1, stopped: null });
    expect(await waitOf(app, bad)).toBe('failed');
    expect((await rowOf(app, good)).classification).toBe('follow_up');
    // Its call may have been paid for: again on another UTC day alone, once.
    for (const at of [NOW + HOUR, TOMORROW - 1]) {
      vi.setSystemTime(at);
      expect(await sweepWaitingMessages(app.db)).toEqual({ queued: 0 });
      await drain(app, a);
    }
    expect(asked()).toEqual(['bad', 'good']);
    vi.setSystemTime(TOMORROW + MINUTE);
    expect(await sweepWaitingMessages(app.db)).toEqual({ queued: 1 });
    await app.jobs.drain();
    await drain(app, a);
    expect(asked()).toEqual(['bad', 'good', 'bad']);
  });

  it('a first job that died is tried at once, and then once a day', async () => {
    const { app, a } = await boot();
    fails(new Error('a defect'));
    const id = await arrives(app, a);
    await runTries(app);
    expect(shown()).toHaveLength(3);
    expect((await rowOf(app, id)).classifyTriedAt).toBeNull();
    await drain(app, a);
    await drain(app, a);
    expect(shown()).toHaveLength(4);
  });

  it('leaves workers for the rest, with ranking’s drains beside it', () => {
    const limits = DEFAULT_KIND_LIMITS;
    expect(limits[CLASSIFY_WAITING_KIND]).toBe(1);
    expect(limits[CLASSIFY_WAITING_KIND]! + limits['discovery.rank_waiting']!).toBeLessThan(4);
  });

  it('an unusable answer is not tried again', async () => {
    const { app, a } = await boot();
    const id = await stored(app, a);
    fails(new AiUnavailableError('invalid_output'));
    expect(await drain(app, a)).toEqual({ classified: 0, left: 1, stopped: null });
    expect(await waitOf(app, id)).toBe('invalid_output');
    expect(await sweepWaitingMessages(app.db)).toEqual({ queued: 0 });
  });

  it('no prompt for it: nothing is sent, and the message says what it said', async () => {
    const { app, a } = await boot();
    const id = await stored(app, a, { wait: 'failed' });
    await app.db.delete(prompts).where(eq(prompts.taskKey, 'comms.classify')).run();
    expect((await drain(app, a)).stopped).toBe('no_prompt');
    expect(await waitOf(app, id)).toBe('failed');
    expect(shown()).toEqual([]);
    // A first job says so, and a row that says something keeps it.
    const first = await arrives(app, a);
    const blocked = await arrives(app, a);
    await setClassifyWait(app.db, ctxOf(a), blocked, 'blocked');
    await app.jobs.drain();
    expect(await waitOf(app, first)).toBe('failed');
    expect(await waitOf(app, blocked)).toBe('blocked');
  });

  it('says it is trying before its call, committed, and is not tried again that day if its process ends', async () => {
    const { app, a } = await boot();
    const id = await stored(app, a);
    let during: unknown;
    classifier(async () => {
      during = await rowOf(app, id);
      return FOLLOW_UP;
    });
    // The process ends in the try: the row is left as it was then.
    vi.setSystemTime(NOW);
    setRaceHook((point) => {
      if (point === 'classifyWaiting.begun') throw new Error('ended');
    });
    await expect(drain(app, a)).rejects.toThrow('ended');
    setRaceHook(undefined);
    const left = await rowOf(app, id);
    expect(left.classifyWait).toBe('trying');
    expect(left.classifyTriedAt).toBeGreaterThanOrEqual(NOW);
    for (const at of [NOW + HOUR, TOMORROW - 1]) {
      vi.setSystemTime(at);
      expect(await listWaitingMessageIds(app.db, ctxOf(a), at)).toEqual([]);
      expect(await sweepWaitingMessages(app.db)).toEqual({ queued: 0 });
    }
    vi.setSystemTime(TOMORROW);
    expect(await sweepWaitingMessages(app.db)).toEqual({ queued: 1 });
    await app.jobs.drain();
    expect(during).toMatchObject({ classifyWait: 'trying', classification: null });
    expect(await rowOf(app, id)).toMatchObject({
      classification: 'follow_up',
      classifyWait: null,
      classifyTriedAt: null,
    });
  });

  it('a server’s stop waits for the call in flight alone', async () => {
    const { app, a } = await boot();
    for (let i = 0; i < 4; i += 1) await stored(app, a);
    await sweepWaitingMessages(app.db);
    let started!: () => void;
    const inCall = new Promise<void>((r) => (started = r));
    let finish!: () => void;
    const held = new Promise<void>((r) => (finish = r));
    classifier(async () => {
      started();
      await held;
      return FOLLOW_UP;
    });
    const runner = startRunner(app.db, {
      services: app.jobs.services,
      workers: 1,
      intervalMs: 5,
    });
    await inCall;
    const stopped = runner.stop();
    finish();
    await stopped;
    expect(shown()).toHaveLength(1);
    expect(await listWaitingMessageIds(app.db, ctxOf(a))).toHaveLength(3);
    const [job] = await jobsOf(app, CLASSIFY_WAITING_KIND);
    expect(job?.result).toMatchObject({ classified: 1, stopped: 'shutdown' });
  });
});

describe('the stop at a refused key, and what ends it', () => {
  const secretId = (res: { json: <T>() => T }) => res.json<{ id: string }>().id;
  async function addKey(c: TestClient): Promise<string> {
    const res = await c.request({
      method: 'POST',
      url: '/api/v1/secrets',
      payload: { kind: 'ai_api_key', label: 'openai', value: 'made-up-key-for-a-test' },
    });
    expect(res.statusCode, res.body).toBe(201);
    return secretId(res);
  }
  const recheck = (c: TestClient, id: string) =>
    c.request({ method: 'POST', url: `/api/v1/ai/keys/${id}/validate` });
  const modelList = (status: number) =>
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(status === 200 ? { data: [] } : { error: 'bad key' }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  const policy = (c: TestClient, task: string) =>
    c.request({
      method: 'PUT',
      url: `/api/v1/ai/policies/${task}`,
      payload: { provider: 'openai', model: 'placeholder-model', maxOutputTokens: 500 },
    });
  const reset = (c: TestClient, task: string) =>
    c.request({ method: 'DELETE', url: `/api/v1/ai/policies/${task}` });

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in this test')));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Two messages whose key was refused, and one of each reason that no end takes back. */
  async function stopped(app: FastifyInstance, c: TestClient) {
    const ids = [
      await stored(app, c, { wait: 'key_rejected' }),
      await stored(app, c, { wait: 'key_rejected' }),
    ];
    const kept: [string, ClassifyWait][] = [
      [await stored(app, c, { wait: 'blocked' }), 'blocked'],
      [await stored(app, c, { wait: 'invalid_output' }), 'invalid_output'],
    ];
    // Ended with the others, and too old for a later try.
    const old = await stored(app, c, { wait: 'key_rejected', createdAt: NOW - 31 * DAY });
    return { ids, kept, old };
  }
  /** What the stop left waits, a drain is queued, and it classifies them; the rest is as it was. */
  async function resumed(
    app: FastifyInstance,
    c: TestClient,
    was: Awaited<ReturnType<typeof stopped>>,
  ) {
    for (const id of was.ids) expect(await waitOf(app, id)).toBe('provider_error');
    for (const [id, wait] of was.kept) expect(await waitOf(app, id)).toBe(wait);
    expect(await waitOf(app, was.old)).toBe('provider_error');
    expect(await drainsQueued(app, c)).toBe(1);
    await drain(app, c);
    expect(await waitOf(app, was.old)).toBe('provider_error');
    for (const id of was.ids) expect((await rowOf(app, id)).classification).toBe('follow_up');
    for (const [id] of was.kept) expect((await rowOf(app, id)).classification).toBeNull();
  }
  async function still(app: FastifyInstance, c: TestClient, ids: string[]) {
    for (const id of ids) expect(await waitOf(app, id)).toBe('key_rejected');
    expect(await drainsQueued(app, c)).toBe(0);
  }

  it('while it lasts the sweep queues nothing for the user, and passes over no other', async () => {
    const { app, a, b } = await boot();
    await stopped(app, a);
    await stored(app, a);
    await stored(app, b);
    expect(await sweepWaitingMessages(app.db)).toEqual({ queued: 1 });
    expect(await drainsQueued(app, a)).toBe(0);
    expect(await drainsQueued(app, b)).toBe(1);
    // Nor does a drain that is queued already make a call.
    expect((await drain(app, a)).stopped).toBe('key_rejected');
    expect(shown()).toEqual([]);
  });

  it('a key added', async () => {
    const { app, a } = await boot();
    const was = await stopped(app, a);
    await addKey(a);
    // Its backfill takes the unusable answer too, as it did; here it has not run.
    await resumed(app, a, was);
  });

  it('a key found good again', async () => {
    const { app, a } = await boot();
    const id = await addKey(a);
    const was = await stopped(app, a);
    vi.stubGlobal('fetch', modelList(200));
    expect((await recheck(a, id)).json<{ ok: boolean }>().ok).toBe(true);
    await resumed(app, a, was);
  });

  it('a key deleted', async () => {
    const { app, a } = await boot();
    const id = await addKey(a);
    const was = await stopped(app, a);
    const res = await a.request({ method: 'DELETE', url: `/api/v1/secrets/${id}` });
    expect(res.statusCode, res.body).toBe(204);
    await resumed(app, a, was);
  });

  it('a model policy for it saved, and one reset', async () => {
    const { app, a } = await boot();
    const was = await stopped(app, a);
    expect((await policy(a, 'comms.classify')).statusCode).toBe(200);
    await resumed(app, a, was);
    const again = await stopped(app, a);
    expect((await reset(a, 'comms.classify')).statusCode).toBe(204);
    for (const id of again.ids) expect(await waitOf(app, id)).toBe('provider_error');
    for (const [id, wait] of again.kept) expect(await waitOf(app, id)).toBe(wait);
  });

  it.each([
    [
      'a key that is not found good',
      async (a: TestClient) => {
        const id = await addKey(a);
        return async () => {
          vi.stubGlobal('fetch', modelList(401));
          await recheck(a, id);
        };
      },
    ],
    [
      'another task’s policy',
      (a: TestClient) => async () => void (await policy(a, 'resume.match')),
    ],
    ['ranking’s policy', (a: TestClient) => async () => void (await policy(a, 'discovery.rank'))],
    ['another task’s reset', (a: TestClient) => async () => void (await reset(a, 'resume.match'))],
    [
      'another kind of secret',
      (a: TestClient) => async () => {
        const res = await a.request({
          method: 'POST',
          url: '/api/v1/secrets',
          payload: { kind: 'device_token', label: 'a device', value: 'made-up-token' },
        });
        expect(res.statusCode, res.body).toBe(201);
        await a.request({ method: 'DELETE', url: `/api/v1/secrets/${secretId(res)}` });
      },
    ],
    [
      'another user’s key and policy',
      (_a: TestClient, b: TestClient) => async () => {
        await addKey(b);
        await policy(b, 'comms.classify');
      },
    ],
  ] as [
    string,
    (a: TestClient, b: TestClient) => (() => Promise<void>) | Promise<() => Promise<void>>,
  ][])('%s ends nothing', async (_name, make) => {
    const { app, a, b } = await boot();
    const act = await make(a, b);
    const { ids } = await stopped(app, a);
    await act();
    await still(app, a, ids);
  });

  // sec on #1058: the change has happened, and neither task's end may be lost to the other's.
  describe('an error in one task’s end does not keep the other from its own', () => {
    /** Ranking's counts what waits, and nothing before it reads a count of that name. */
    const rankingFails = (app: FastifyInstance) => {
      const select = app.db.select.bind(app.db);
      vi.spyOn(app.db, 'select').mockImplementation(((fields?: object) => {
        if (fields !== undefined && 'n' in fields) throw new Error('read failed');
        return select(fields as never);
      }) as never);
    };
    const mailFails = () =>
      setRaceHook((point) => {
        if (point === 'classify.resume') throw new Error('mail failed');
      });
    afterEach(() => {
      vi.restoreAllMocks();
    });
    const add = (c: TestClient) =>
      c.request({
        method: 'POST',
        url: '/api/v1/secrets',
        payload: { kind: 'ai_api_key', label: 'anthropic', value: 'made-up-key-for-a-test' },
      });
    const WAYS: [string, (c: TestClient, id: string) => Promise<{ statusCode: number }>][] = [
      ['a key added', (c) => add(c)],
      ['a key deleted', (c, id) => c.request({ method: 'DELETE', url: `/api/v1/secrets/${id}` })],
      [
        'a key found good',
        (c, id) => {
          vi.stubGlobal('fetch', modelList(200));
          return recheck(c, id);
        },
      ],
    ];
    it.each(WAYS)('%s: ranking’s fails, mail’s is ended', async (_name, act) => {
      const { app, a } = await boot();
      const id = await addKey(a);
      const { ids } = await stopped(app, a);
      rankingFails(app);
      expect((await act(a, id)).statusCode).toBe(500);
      vi.restoreAllMocks();
      for (const was of ids) expect(await waitOf(app, was)).toBe('provider_error');
    });
    it.each(WAYS)('%s: mail’s fails, ranking’s is ended', async (_name, act) => {
      const { app, a } = await boot();
      const id = await addKey(a);
      await app.db.delete(jobs).where(eq(jobs.kind, CLASSIFY_BACKFILL_KIND)).run();
      const before = await readKeyChangedAt(app.db, ctxOf(a));
      vi.setSystemTime(Date.now() + MINUTE);
      mailFails();
      expect((await act(a, id)).statusCode).toBe(500);
      expect(await readKeyChangedAt(app.db, ctxOf(a))).toBeGreaterThan(before);
      // And the mail that had no key is queued where a key came.
      if (_name === 'a key added')
        expect(await jobsOf(app, CLASSIFY_BACKFILL_KIND)).toHaveLength(1);
    });
  });

  it('it writes the messages under the user’s lock, as what writes several does', async () => {
    const { app, a } = await boot();
    const { ids } = await stopped(app, a);
    await heldApart(
      app,
      'reclassify.read',
      () => reclassify(app.db, ctxOf(a), ids[0]!, { classification: 'networking' }),
      () => resumeClassifyAfterKeyChange(app.db, ctxOf(a)),
    );
    expect((await rowOf(app, ids[0]!)).classifyWait).toBeNull();
    expect(await waitOf(app, ids[1]!)).toBe('provider_error');
  });

  it('with no room in the budget: they wait, and no drain is queued', async () => {
    const { app, a } = await boot();
    const { ids } = await stopped(app, a);
    await spend(app, a, 3);
    await policy(a, 'comms.classify');
    for (const id of ids) expect(await waitOf(app, id)).toBe('provider_error');
    expect(await drainsQueued(app, a)).toBe(0);
  });

  it('a policy saved to the same refused key costs one call, and stops again', async () => {
    const { app, a } = await boot();
    const { ids } = await stopped(app, a);
    fails(refused());
    for (const calls of [1, 2]) {
      vi.setSystemTime(Date.now() + MINUTE);
      await policy(a, 'comms.classify');
      vi.setSystemTime(Date.now() + MINUTE);
      await app.jobs.drain();
      expect(shown()).toHaveLength(calls);
      expect(await Promise.all(ids.map((id) => waitOf(app, id)))).toContain('key_rejected');
      expect(await sweepWaitingMessages(app.db)).toEqual({ queued: 0 });
    }
  });

  it('a 401 of a call that began before a change marks nothing, and is tried with what there is now', async () => {
    const { app, a } = await boot();
    const id = await stored(app, a);
    classifier(async () => {
      if (shown().length > 1) return FOLLOW_UP;
      vi.setSystemTime(Date.now() + 1000);
      await policy(a, 'comms.classify');
      throw refused();
    });
    expect(await drain(app, a)).toEqual({ classified: 1, left: 0, stopped: null });
    expect((await rowOf(app, id)).classification).toBe('follow_up');
  });

  it('the same of a first job: tried again by the runner, with its text', async () => {
    const { app, a } = await boot();
    const id = await arrives(app, a);
    classifier(async () => {
      if (shown().length > 1) return FOLLOW_UP;
      vi.setSystemTime(Date.now() + 1000);
      await policy(a, 'comms.classify');
      throw refused();
    });
    await app.jobs.drain();
    expect(await waitOf(app, id)).toBeNull();
    await runTries(app);
    expect(await rowOf(app, id)).toMatchObject({
      classification: 'follow_up',
      bodySource: 'payload',
    });
  });

  it('a call that found no key while one was being added: tried again, though the backfill has passed', async () => {
    const { app, a } = await boot();
    const id = await arrives(app, a);
    classifier(async () => {
      if (shown().length > 1) return FOLLOW_UP;
      vi.setSystemTime(Date.now() + 1000);
      await addKey(a);
      // Its backfill runs now, and passes this message: its job is not over.
      await app.db.delete(jobs).where(eq(jobs.kind, CLASSIFY_BACKFILL_KIND)).run();
      expect(await backfillClassify(app.db, ctxOf(a))).toBe(1);
      throw new AiUnavailableError('no_key');
    });
    await runTries(app);
    expect((await rowOf(app, id)).classification).toBe('follow_up');
  });

  it('one that says no key while a key is being added is the backfill’s, which is queued after', async () => {
    const { app, a } = await boot();
    let id = '';
    setRaceHook(async (point) => {
      if (point !== 'classify.resume') return;
      setRaceHook(undefined);
      // Whatever the key's route has queued by now is run, and then the message says it.
      await app.jobs.drain();
      fails(new AiUnavailableError('no_key'));
      id = await arrives(app, a);
      await app.jobs.drain();
      expect(await waitOf(app, id)).toBe('no_key');
      classifier(() => FOLLOW_UP);
    });
    await addKey(a);
    await app.jobs.drain();
    expect((await rowOf(app, id)).classification).toBe('follow_up');
  });

  it('a stored time ahead of the clock: three calls at most in a drain, and it still waits', async () => {
    const { app, a } = await boot();
    const id = await stored(app, a);
    await writeSetting(app.db, ctxOf(a), `classify_key_changed:${a.userId}`, NOW + DAY);
    fails(refused());
    expect((await drain(app, a)).stopped).toBe('provider_error');
    expect(shown()).toHaveLength(3);
    expect(await waitOf(app, id)).toBe('provider_error');
  });

  it('a stop that ends while a message reads it does not begin again by that message', async () => {
    const { app, a } = await boot();
    const { ids } = await stopped(app, a);
    const id = await arrives(app, a);
    setRaceHook(async (point) => {
      if (point !== 'classify.stopped') return;
      setRaceHook(undefined);
      await policy(a, 'comms.classify');
    });
    await app.jobs.drain();
    expect((await rowOf(app, id)).classification).toBe('follow_up');
    for (const was of ids) expect((await rowOf(app, was)).classification).toBe('follow_up');
  });
});

describe('mail that came over 30 days ago, and a new key', () => {
  const OLD = NOW - 60 * DAY;
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in this test')));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const addKey = async (c: TestClient, label: string) => {
    const res = await c.request({
      method: 'POST',
      url: '/api/v1/secrets',
      payload: { kind: 'ai_api_key', label, value: 'made-up-key-for-a-test' },
    });
    expect(res.statusCode, res.body).toBe(201);
  };

  it('a wrong key and then the right one: one call to the wrong, and each is classified', async () => {
    const { app, a } = await boot();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(await stored(app, a, { wait: 'no_key', createdAt: OLD }));
    }
    fails(refused());
    await addKey(a, 'openai');
    await app.jobs.drain();
    expect(shown()).toHaveLength(1);
    for (const id of ids) expect(await waitOf(app, id)).toBe('key_rejected');

    vi.setSystemTime(Date.now() + MINUTE);
    classifier(() => FOLLOW_UP);
    await addKey(a, 'anthropic');
    await app.jobs.drain();
    for (const id of ids) expect((await rowOf(app, id)).classification).toBe('follow_up');
    expect(shown()).toHaveLength(6);
  });

  it('a new key takes whatever only its age keeps from a later try', async () => {
    const { app, a } = await boot();
    const taken: string[] = [];
    for (const [wait, triedAt] of [
      ['budget_exceeded', null],
      ['provider_error', NOW - MINUTE],
      ['failed', null],
      ['trying', NOW - DAY],
      ['key_rejected', null],
      ['no_key', null],
      ['invalid_output', null],
      [null, null],
    ] as const) {
      taken.push(await stored(app, a, { wait, triedAt, createdAt: OLD }));
    }
    await stored(app, a, { wait: 'blocked', createdAt: OLD });
    // A try of it is under way.
    await stored(app, a, { wait: 'trying', triedAt: NOW - MINUTE, createdAt: OLD });
    expect(await backfillClassify(app.db, ctxOf(a))).toBe(taken.length);
    const queued = (await jobsOf(app, CLASSIFY_JOB_KIND)).map(
      (j) => (j.payload as { communicationId: string }).communicationId,
    );
    expect(queued.sort()).toEqual([...taken].sort());
  });
});

describe('the backfill on a new key', () => {
  it('takes what no later try does, newest first', async () => {
    const { app, a, b } = await boot();
    const taken: string[] = [];
    for (const [i, wait] of ([null, 'no_key', 'invalid_output'] as const).entries()) {
      taken.push(await stored(app, a, { wait, sentAt: NOW - (3 - i) * HOUR }));
    }
    for (const wait of [
      'budget_exceeded',
      'provider_error',
      'failed',
      'trying',
      'key_rejected',
      'blocked',
    ] as const) {
      await stored(app, a, { wait, sentAt: NOW });
    }
    await stored(app, b, { wait: null });
    // Nor one that is not to be classified, whatever its row says and however old it is.
    for (const over of [
      { classification: 'other' as const },
      { rejectedAt: NOW },
      { triageDecision: 'filtered' },
    ]) {
      for (const wait of [null, 'no_key', 'budget_exceeded'] as const) {
        const id = await stored(app, a, { wait, createdAt: NOW - 60 * DAY });
        await app.db.update(communications).set(over).where(eq(communications.id, id)).run();
      }
    }
    await enqueueClassifyBackfill(app.db, ctxOf(a));
    await backfillClassify(app.db, ctxOf(a));
    const queued = (await jobsOf(app, CLASSIFY_JOB_KIND))
      .sort((x, y) => (x.id < y.id ? -1 : 1))
      .map((j) => (j.payload as { communicationId: string }).communicationId);
    expect(queued).toEqual([...taken].reverse());
  });
});

describe('what the Inbox is told', () => {
  const counts = async (c: TestClient) => {
    const res = await c.request({ method: 'GET', url: '/api/v1/communications/unclassified' });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Record<string, number>>();
  };
  const NONE = {
    budget_exceeded: 0,
    provider_error: 0,
    failed: 0,
    trying: 0,
    key_rejected: 0,
    no_key: 0,
    invalid_output: 0,
    no_longer_tried: 0,
  };

  it('a number by reason, of the caller’s own messages alone', async () => {
    const { app, a, b } = await boot();
    expect(await counts(a)).toEqual(NONE);
    for (const wait of [
      'budget_exceeded',
      'budget_exceeded',
      'provider_error',
      'failed',
      'trying',
      'key_rejected',
      'no_key',
      'invalid_output',
      'blocked',
      null,
    ] as const) {
      await stored(app, a, { wait, triedAt: wait === 'trying' ? NOW : null });
    }
    // Over 30 days: these were to be tried, and are not any more; a refused key is the user's to end.
    const createdAt = NOW - 31 * DAY;
    for (const wait of ['budget_exceeded', 'key_rejected', 'trying'] as const) {
      await stored(app, a, { wait, createdAt });
    }
    // These never were, whatever their age.
    for (const wait of ['no_key', 'invalid_output'] as const) {
      await stored(app, a, { wait, createdAt });
    }
    // Not those rejected or classified meanwhile.
    const gone = await stored(app, a);
    await rejectCommunication(app.db, ctxOf(a), gone, {
      reason: 'other',
      expectedOpportunityId: null,
    });
    const typed = await stored(app, a);
    await reclassify(app.db, ctxOf(a), typed, { classification: 'other' });
    // Whatever is left in such a row.
    for (const over of [
      { classification: 'other' as const },
      { rejectedAt: NOW },
      { triageDecision: 'filtered' },
    ]) {
      const id = await stored(app, a);
      await app.db.update(communications).set(over).where(eq(communications.id, id)).run();
    }
    expect(await counts(a)).toEqual({
      budget_exceeded: 2,
      provider_error: 1,
      failed: 1,
      trying: 1,
      key_rejected: 2,
      no_key: 2,
      invalid_output: 2,
      no_longer_tried: 2,
    });
    expect(await counts(b)).toEqual(NONE);
  });

  it('needs a session', async () => {
    const { app } = await boot();
    const res = await app.inject({ method: 'GET', url: '/api/v1/communications/unclassified' });
    expect(res.statusCode).toBe(401);
  });
});

describe('what a person does to a waiting message ends its wait', () => {
  it('a reject clears both columns, and a correction does', async () => {
    const { app, a } = await boot();
    const rejected = await stored(app, a, { triedAt: NOW });
    const typed = await stored(app, a, { triedAt: NOW });
    await rejectCommunication(app.db, ctxOf(a), rejected, {
      reason: 'other',
      expectedOpportunityId: null,
    });
    await reclassify(app.db, ctxOf(a), typed, { classification: 'networking' });
    for (const id of [rejected, typed]) {
      expect(await rowOf(app, id)).toMatchObject({ classifyWait: null, classifyTriedAt: null });
    }
  });
});
