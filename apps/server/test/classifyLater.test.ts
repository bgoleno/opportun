// A message whose classification met a spent budget or an outage is classified later, by itself
// (https://github.com/bgoleno/opportun/issues/1050). From the queue alone, with the clock moved: what
// waits and how is in classifyWaiting.test.ts. The provider is mocked and every message is made up.
import { AiUnavailableError, runStructured } from '@opportun/ai';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { communications, jobs } from '../src/db/schema';
import { ingestInbound } from '../src/jobs/mailIngest';
import { readSchedules, removeSchedule } from '../src/lib/jobQueue';
import { useApi } from './api';
import type { TestClient } from './isolation';

vi.mock('@opportun/ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@opportun/ai')>();
  return { ...real, runStructured: vi.fn() };
});

const boot = useApi();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** 19:00 UTC: five hours before the budget's next day. */
const START = Date.UTC(2026, 10, 12, 19);
const MIDNIGHT = Date.UTC(2026, 10, 13);

beforeEach(() => {
  vi.useFakeTimers({ now: START, toFake: ['Date'] });
  vi.mocked(runStructured).mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

const OTHER = {
  classification: 'follow_up',
  outreachKind: null,
  mismatchReason: null,
  opportunityMatch: null,
  proposedTransition: null,
  confidence: 0.9,
  hardConstraintViolation: null,
};

/** What the provider does with each classification; any other task (mail triage) gets nothing. */
function classifier(answer: () => unknown): void {
  vi.mocked(runStructured).mockImplementation(async (_deps, task) =>
    task === 'comms.classify' ? (answer() as never) : (undefined as never),
  );
}
const classifyCalls = () =>
  vi.mocked(runStructured).mock.calls.filter((c) => c[1] === 'comms.classify').length;

/** One message arrives, and is stored with its job queued. */
async function arrives(app: FastifyInstance, c: TestClient): Promise<string> {
  const { id } = await ingestInbound(
    app.db,
    { userId: c.userId, isAdmin: false },
    app.storage,
    'apple_mail',
    {
      externalId: 'apple-mail:later@mail.example',
      threadKey: 'thread-later',
      from: 'Riley Recruiter <riley@initech.example>',
      to: ['me@example.com'],
      subject: 'Your application for Staff Engineer',
      snippet: 'Thank you for applying to the Staff Engineer role.',
      bodyText: 'Thank you for applying to the Staff Engineer role. We will be in touch.',
      sentAt: START - MINUTE,
    },
  );
  return id;
}

/** Only the sweep of waiting mail stays: the other schedules make calls of their own. */
async function onlyTheSweep(app: FastifyInstance): Promise<void> {
  for (const { kind } of await readSchedules(app.db)) {
    if (kind !== 'comms.classify_waiting_sweep') await removeSchedule(app.db, kind);
  }
}

const rowOf = async (app: FastifyInstance, id: string) =>
  (await app.db.select().from(communications).where(eq(communications.id, id)).get())!;

/** The queue runs at every step until then. */
async function until(app: FastifyInstance, at: number, step: number): Promise<void> {
  while (Date.now() < at) {
    vi.setSystemTime(Date.now() + step);
    await app.jobs.drain();
  }
}

describe('mail that could not be classified is classified later, with nobody doing anything', () => {
  it('a spent budget: after the budget returns', async () => {
    const { app, a } = await boot();
    await onlyTheSweep(app);
    classifier(() => {
      if (Date.now() < MIDNIGHT) throw new AiUnavailableError('budget_exceeded');
      return OTHER;
    });
    const id = await arrives(app, a);
    await app.jobs.drain();
    await until(app, MIDNIGHT - MINUTE, 10 * MINUTE);
    expect((await rowOf(app, id)).classification).toBeNull();

    await until(app, MIDNIGHT + 2 * HOUR, 10 * MINUTE);
    expect((await rowOf(app, id)).classification).toBe('follow_up');
    expect((await app.db.select().from(jobs).all()).map((j) => j.status)).not.toContain('dead');
  });

  it('an outage: once the provider answers', async () => {
    const { app, a } = await boot();
    await onlyTheSweep(app);
    classifier(() => {
      if (classifyCalls() <= 4) throw new AiUnavailableError('provider_error', 'out');
      return OTHER;
    });
    const id = await arrives(app, a);
    await app.jobs.drain();
    await until(app, START + 30 * MINUTE, 5 * MINUTE);
    expect(classifyCalls(), 'the runner’s own tries').toBe(3);
    expect((await rowOf(app, id)).classification).toBeNull();

    await until(app, START + 4 * HOUR, 5 * MINUTE);
    expect((await rowOf(app, id)).classification).toBe('follow_up');
    expect(classifyCalls()).toBe(5);
    expect((await app.db.select().from(jobs).all()).map((j) => j.status)).not.toContain('dead');
  });

  it('a key that is refused: one call, and none after', async () => {
    const { app, a } = await boot();
    await onlyTheSweep(app);
    classifier(() => {
      throw new AiUnavailableError('provider_error', 'HTTP 401', { keyRejected: true });
    });
    await arrives(app, a);
    await app.jobs.drain();
    await until(app, START + DAY, 30 * MINUTE);
    expect(classifyCalls()).toBe(1);
  });
});
