// What the tests of waiting mail share (https://github.com/bgoleno/opportun/issues/1050). Every message
// is made up, and the provider is mocked in each file: `@opportun/ai` with runStructured a vi.fn().
import { runStructured } from '@opportun/ai';
import { newId, type ClassifyWait, type CommChannel } from '@opportun/core';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { vi } from 'vitest';
import { communications, jobs, taskRuns } from '../src/db/schema';
import { bodyRefetchFor, type ClassifyOutput } from '../src/jobs/classify';
import { drainWaitingMessages, type ClassifyDrainOutcome } from '../src/jobs/classifyWaiting';
import { CLASSIFY_WAITING_KIND } from '../src/lib/mailClassifyQueue';
import { readSchedules, removeSchedule } from '../src/lib/jobQueue';
import type { UserCtx } from '../src/repos/base';
import { upsertInbound } from '../src/repos/communications';
import type { TestClient } from './isolation';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** A Thursday, 07:00 UTC: the clock every one of these tests starts from. */
export const NOW = Date.UTC(2026, 10, 12, 7);
/** The next budget day. */
export const TOMORROW = Date.UTC(2026, 10, 13);

export const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });

export const FOLLOW_UP: ClassifyOutput = {
  classification: 'follow_up',
  outreachKind: null,
  mismatchReason: null,
  opportunityMatch: null,
  proposedTransition: null,
  confidence: 0.9,
  hardConstraintViolation: null,
};
/** One that makes an opportunity, an activity on it and a job. */
export const TARGETED: ClassifyOutput = {
  ...FOLLOW_UP,
  classification: 'solicitation',
  outreachKind: 'targeted',
  opportunityMatch: { company: 'Initech', title: 'Staff Engineer' },
};

/** What the provider does with each classification; any other task (mail triage) gets nothing. */
export function classifier(answer: (system: string) => unknown): void {
  vi.mocked(runStructured).mockImplementation(async (_deps, task, opts) =>
    task === 'comms.classify' ? ((await answer(opts.system)) as never) : (undefined as never),
  );
}
/** The messages the classifier was shown, in order. */
export const shown = (): string[] =>
  vi
    .mocked(runStructured)
    .mock.calls.filter((c) => c[1] === 'comms.classify')
    .map((c) => c[2].system);
/** Their subjects. */
export const asked = (): string[] => shown().map((s) => /^Subject: (.*)$/m.exec(s)?.[1] ?? '');

export interface Stored {
  subject?: string;
  from?: string;
  to?: string[];
  channel?: CommChannel;
  wait?: ClassifyWait | null;
  triedAt?: number | null;
  sentAt?: number;
  createdAt?: number;
  snippet?: string;
  threadKey?: string;
  externalId?: string;
}

let seq = 0;
/** A message as ingest leaves it, unclassified, its first job over: for the reason given. */
export async function stored(
  app: FastifyInstance,
  c: TestClient,
  over: Stored = {},
): Promise<string> {
  seq += 1;
  const { id } = await upsertInbound(
    app.db,
    ctxOf(c),
    over.channel ?? 'apple_mail',
    {
      externalId: over.externalId ?? `ext-${seq}`,
      threadKey: over.threadKey ?? `thread-${seq}`,
      from: over.from ?? 'Riley Recruiter <riley@initech.example>',
      to: over.to ?? ['me@example.com'],
      subject: over.subject ?? `Message ${seq}`,
      snippet: over.snippet ?? 'The Staff Engineer role: a short snippet.',
      bodyText: '',
      sentAt: over.sentAt ?? NOW - seq * MINUTE,
    },
    { decision: 'passed', rule: 'vocabulary' },
  );
  await app.db
    .update(communications)
    .set({
      classifyWait: over.wait === undefined ? 'budget_exceeded' : over.wait,
      classifyTriedAt: over.triedAt ?? null,
      ...(over.createdAt === undefined ? {} : { createdAt: over.createdAt }),
    })
    .where(eq(communications.id, id))
    .run();
  return id;
}

export const rowOf = async (app: FastifyInstance, id: string) =>
  (await app.db.select().from(communications).where(eq(communications.id, id)).get())!;
export const waitOf = async (app: FastifyInstance, id: string) =>
  (await rowOf(app, id)).classifyWait;

/** The caller's drain, as its job runs it. */
export const drain = (
  app: FastifyInstance,
  c: TestClient,
  opts: { stopping?: () => boolean } = {},
): Promise<ClassifyDrainOutcome> =>
  drainWaitingMessages(app.db, ctxOf(c), app.storage, {
    refetch: bodyRefetchFor(app.db, ctxOf(c), app.jobs.services),
    ...opts,
  });

export const jobsOf = (app: FastifyInstance, ...kinds: string[]) =>
  app.db.select().from(jobs).where(inArray(jobs.kind, kinds)).all();
export const drainsQueued = async (app: FastifyInstance, c: TestClient): Promise<number> =>
  (
    await app.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.kind, CLASSIFY_WAITING_KIND),
          eq(jobs.userId, c.userId),
          eq(jobs.status, 'pending'),
        ),
      )
      .all()
  ).length;

/** A recorded call of the task, as the router writes one. */
export async function spend(
  app: FastifyInstance,
  c: TestClient,
  usd: number,
  over: { taskKey?: string; at?: number } = {},
): Promise<void> {
  await app.db
    .insert(taskRuns)
    .values({
      id: newId(),
      userId: c.userId,
      taskKey: over.taskKey ?? 'comms.classify',
      provider: 'openai',
      model: 'placeholder-model',
      inputTokens: 100,
      outputTokens: 10,
      estCost: usd,
      fallbackPricing: false,
      durationMs: 1,
      status: 'ok',
      error: null,
      createdAt: over.at ?? Date.now(),
    })
    .run();
}

/** Only this schedule stays, or none: the others make calls of their own. */
export async function onlySchedule(app: FastifyInstance, kept: string | null): Promise<void> {
  for (const { kind } of await readSchedules(app.db)) {
    if (kind !== kept) await removeSchedule(app.db, kind);
  }
}
