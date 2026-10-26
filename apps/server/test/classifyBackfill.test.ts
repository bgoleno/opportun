import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { communications, jobs } from '../src/db/schema';
import { CLASSIFY_BACKFILL_KIND, classifyBackfillDedupeKey } from '../src/jobs/classifyBackfill';
import { CLASSIFY_JOB_KIND } from '../src/jobs/gmailSync';
import { runNextJob } from '../src/jobs/runner';
import { upsertInbound } from '../src/repos/communications';
import { useApi } from './api';
import type { TestClient } from './isolation';

const boot = useApi();

let seq = 0;
async function insertMessage(app: FastifyInstance, userId: string): Promise<string> {
  seq += 1;
  return (
    await upsertInbound(app.db, { userId, isAdmin: false }, 'gmail', {
      externalId: `backfill-ext-${seq}`,
      threadKey: `backfill-thread-${seq}`,
      from: 'Riley Recruiter <riley@acme.example>',
      to: ['me@example.com'],
      subject: `Subject ${seq}`,
      snippet: `Snippet ${seq}`,
      bodyText: `Body ${seq}`,
      sentAt: Date.now() - 1000 * seq,
    })
  ).id;
}

async function markClassified(app: FastifyInstance, id: string): Promise<void> {
  await app.db
    .update(communications)
    .set({ classification: 'other' })
    .where(eq(communications.id, id))
    .run();
}

/**
 * Overwrites a just-inserted row's id and createdAt. The real write path (upsertInbound) always
 * generates an id via newId() (uuidv7) and stamps createdAt with Date.now() in the same call, so
 * the two can never disagree on ordering through that path alone. This constructs the shape
 * issue #286 is about: a row whose id does not sort the way it was created, a future a
 * non-uuidv7 id source (or, today, a hand-crafted row like this) can produce.
 */
async function insertMessageAt(
  app: FastifyInstance,
  userId: string,
  id: string,
  createdAt: number,
): Promise<string> {
  const realId = await insertMessage(app, userId);
  await app.db
    .update(communications)
    .set({ id, createdAt })
    .where(eq(communications.id, realId))
    .run();
  return id;
}

async function jobsOfKind(app: FastifyInstance, kind: string) {
  return await app.db.select().from(jobs).where(eq(jobs.kind, kind)).all();
}

async function classifyTargets(app: FastifyInstance): Promise<string[]> {
  return (await jobsOfKind(app, CLASSIFY_JOB_KIND))
    .map((j) => (j.payload as { communicationId: string }).communicationId)
    .sort();
}

async function addKey(c: TestClient, kind = 'ai_api_key'): Promise<void> {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/secrets',
    payload: { kind, label: 'AI key', value: 'sk-test-backfill-value' },
  });
  expect(res.statusCode, res.body).toBe(201);
}

/** Runs only the queued backfill jobs (classify jobs stay pending for inspection). */
async function runBackfills(app: FastifyInstance): Promise<void> {
  // Classify jobs are parked in the future so runNextJob only claims backfills.
  const later = Date.now() + 3_600_000;
  await app.db
    .update(jobs)
    .set({ runAt: later })
    .where(and(eq(jobs.kind, CLASSIFY_JOB_KIND), eq(jobs.status, 'pending')))
    .run();
  while (await runNextJob(app.db)) {
    await app.db
      .update(jobs)
      .set({ runAt: later })
      .where(and(eq(jobs.kind, CLASSIFY_JOB_KIND), eq(jobs.status, 'pending')))
      .run();
  }
}

describe('classify backfill', () => {
  it('adding an ai_api_key secret enqueues one backfill job for that user', async () => {
    const { app, a } = await boot();
    await addKey(a);
    const backfills = await jobsOfKind(app, CLASSIFY_BACKFILL_KIND);
    expect(backfills).toHaveLength(1);
    expect(backfills[0]?.userId).toBe(a.userId);
    expect(backfills[0]?.dedupeKey).toBe(classifyBackfillDedupeKey(a.userId));
    expect(backfills[0]?.dedupeKey).toBe(`classify_backfill:${a.userId}`);
  });

  it('other secret kinds do not enqueue a backfill', async () => {
    const { app, a } = await boot();
    await addKey(a, 'device_token');
    expect(await jobsOfKind(app, CLASSIFY_BACKFILL_KIND)).toHaveLength(0);
  });

  it('enqueues comms.classify only for the user’s unclassified messages', async () => {
    const { app, a, b } = await boot();
    const unclassified = [await insertMessage(app, a.userId), await insertMessage(app, a.userId)];
    const classified = await insertMessage(app, a.userId);
    await markClassified(app, classified);
    await insertMessage(app, b.userId);

    await addKey(a);
    await runBackfills(app);

    expect(await classifyTargets(app)).toEqual([...unclassified].sort());
    for (const job of await jobsOfKind(app, CLASSIFY_JOB_KIND)) expect(job.userId).toBe(a.userId);
    expect((await jobsOfKind(app, CLASSIFY_BACKFILL_KIND)).map((j) => j.status)).toEqual(['done']);
  });

  it('covers more than one batch of 100', async () => {
    const { app, a } = await boot();
    const ids: string[] = [];
    for (let i = 0; i < 205; i++) ids.push(await insertMessage(app, a.userId));
    await addKey(a);
    await runBackfills(app);
    expect(await classifyTargets(app)).toEqual([...ids].sort());
  });

  it('queues in createdAt order, not id order, when the two disagree (issue #286)', async () => {
    const { app, a } = await boot();
    // ids assigned in exactly the reverse of createdAt order: ascending-id order is row-e, row-d,
    // row-c, row-b, row-a, the opposite of creation order. The real write path can never produce
    // this (id and createdAt always rise together); it's the shape a non-monotonic id source
    // would.
    const rows = [
      { id: 'row-e', createdAt: 1_000 },
      { id: 'row-d', createdAt: 2_000 },
      { id: 'row-c', createdAt: 3_000 },
      { id: 'row-b', createdAt: 4_000 },
      { id: 'row-a', createdAt: 5_000 },
    ];
    for (const r of rows) await insertMessageAt(app, a.userId, r.id, r.createdAt);

    await addKey(a);
    await runBackfills(app);

    // Jobs are queued one per communication, in the order backfillClassify visits them. Job ids
    // are uuidv7, generated in this same tight sequential loop, so sorting by id recovers that
    // order (confirmed monotonic for rapid same-process calls, not just assumed).
    const queueOrder = (await jobsOfKind(app, CLASSIFY_JOB_KIND))
      .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
      .map((j) => (j.payload as { communicationId: string }).communicationId);
    expect(queueOrder).toEqual(['row-e', 'row-d', 'row-c', 'row-b', 'row-a']);
  });

  it('covers more than one batch of 100, in createdAt order, when id order disagrees throughout (issue #286)', async () => {
    const { app, a } = await boot();
    // 205 rows (as in the single-batch-boundary test above), but with every id assigned in the
    // exact reverse of createdAt order, including across what will become page boundaries. A
    // compound cursor that got the (createdAt, id) tuple comparison wrong (e.g. an AND where an
    // OR belongs) would duplicate or drop rows right at a page split, or queue them out of
    // createdAt order; neither would show up while id order happens to track createdAt order the
    // way the real write path's always does.
    const total = 205;
    const createdAtOrder: string[] = [];
    for (let i = 0; i < total; i++) {
      const id = `row-${String(total - i).padStart(4, '0')}`;
      createdAtOrder.push(await insertMessageAt(app, a.userId, id, 1_000 + i));
    }
    await addKey(a);
    await runBackfills(app);

    const queueOrder = (await jobsOfKind(app, CLASSIFY_JOB_KIND))
      .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
      .map((j) => (j.payload as { communicationId: string }).communicationId);
    expect(queueOrder).toEqual(createdAtOrder);
  });

  it('is idempotent: a second key add does not double-enqueue pending classify jobs', async () => {
    const { app, a } = await boot();
    const ids = [await insertMessage(app, a.userId), await insertMessage(app, a.userId)];

    // Two adds before the backfill runs share one unfinished backfill job.
    await addKey(a);
    await addKey(a);
    expect(await jobsOfKind(app, CLASSIFY_BACKFILL_KIND)).toHaveLength(1);
    await runBackfills(app);

    // A later add runs a fresh backfill, which finds the classify jobs still pending.
    await addKey(a);
    await runBackfills(app);
    expect(await jobsOfKind(app, CLASSIFY_BACKFILL_KIND)).toHaveLength(2);
    expect(await classifyTargets(app)).toEqual([...ids].sort());
  });
});
