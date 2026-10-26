// Purging what is already stored (spec D5, Plan 3 Task 4).
//
// The filters decide what arrives and Task 1 decides what is kept from here on. This is the
// answer to "what about everything you already have", and it is the one destructive action in
// the mail funnel the user reaches for themselves, so the parts that matter are: a preview that
// changes nothing, an accepted lead that is never touched, a tombstone that keeps dedupe working
// so a purged lead does not come back on the next sync, and a body that some unfinished job is
// still going to read being left alone.
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  auditLog,
  communications,
  discoveryResults,
  discoveryRuns,
  discoverySources,
  jobs,
} from '../src/db/schema';
import { CLASSIFY_JOB_KIND, classifyDedupeKey } from '../src/jobs/mailIngest';
import {
  drainBlockingClassifyJobs,
  previewPurge,
  purgeDiscoveryContent,
  purgeMailBodies,
} from '../src/jobs/purge';
import { upsertInbound } from '../src/repos/communications';
import { storeBodyFor } from './storedBody';
import { useApi } from './api';
import { newId } from '@opportun/core';

const boot = useApi();
const ctxOf = (userId: string) => ({ userId, isAdmin: false });

let seq = 0;

/** One discovery result, with a posting rich enough that purging it is visible. */
async function lead(
  app: FastifyInstance,
  userId: string,
  over: Partial<typeof discoveryResults.$inferInsert> = {},
): Promise<string> {
  seq += 1;
  const ctx = ctxOf(userId);
  const sourceId = newId();
  const runId = newId();
  const now = Date.now();
  await app.db
    .insert(discoverySources)
    .values({
      id: sourceId,
      userId: ctx.userId,
      kind: 'alert_email',
      config: {},
      enabled: true,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  await app.db
    .insert(discoveryRuns)
    .values({ id: runId, userId: ctx.userId, sourceId, startedAt: now, stats: {} })
    .run();
  const id = newId();
  await app.db
    .insert(discoveryResults)
    .values({
      id,
      userId: ctx.userId,
      runId,
      posting: {
        company: 'Northwind Systems',
        title: 'Staff Engineer',
        location: 'United States',
        descriptionMd: 'A very long description that nobody needs to keep a copy of.',
        postingUrl: 'https://boards.greenhouse.io/northwind/jobs/4242',
        compNote: '$200,000',
      },
      dedupeKey: `dedupe-${seq}`,
      aiScore: 70,
      aiRationale: 'The model explaining itself at length about this posting.',
      resolution: 'needs_capture',
      disposition: 'pending',
      createdAt: now,
      updatedAt: now,
      ...over,
    })
    .run();
  return id;
}

const leadById = async (app: FastifyInstance, userId: string, id: string) =>
  (await app.db
    .select()
    .from(discoveryResults)
    .where(and(eq(discoveryResults.userId, userId), eq(discoveryResults.id, id)))
    .get())!;

/** A stored message with a body on disk, as every message had before Plan 3 Task 1. */
async function withBody(
  app: FastifyInstance,
  userId: string,
  body = 'The full text of a message nobody wants kept.',
): Promise<{ id: string; bodyRef: string }> {
  seq += 1;
  const { id } = await upsertInbound(app.db, ctxOf(userId), 'gmail', {
    externalId: `purge-${seq}`,
    threadKey: `purge-${seq}`,
    from: 'recruiter@northwind-systems.example',
    to: ['me@user.example'],
    subject: 'Next steps',
    snippet: body.slice(0, 80),
    bodyText: body,
    sentAt: Date.now() - seq * 1000,
  });
  return { id, bodyRef: await storeBodyFor(app, userId, id, body) };
}

const commById = async (app: FastifyInstance, userId: string, id: string) =>
  (await app.db
    .select()
    .from(communications)
    .where(and(eq(communications.userId, userId), eq(communications.id, id)))
    .get())!;

const fileExists = async (app: FastifyInstance, ref: string): Promise<boolean> => {
  try {
    (await app.storage.openAttachment(ref)).destroy();
    return true;
  } catch {
    return false;
  }
};

describe('previewPurge', () => {
  it('counts what each purge would take, and changes nothing', async () => {
    const { app, a } = await boot();
    const kept = await lead(app, a.userId);
    const { id: mail } = await withBody(app, a.userId);

    const preview = await previewPurge(app.db, ctxOf(a.userId));

    expect(preview).toMatchObject({ discoveryResults: 1, mailBodies: 1, bodiesInUse: 0 });
    // Nothing moved: a preview the user has not agreed to is a read.
    expect((await leadById(app, a.userId, kept)).aiRationale).not.toBeNull();
    expect((await commById(app, a.userId, mail)).bodyRef).not.toBeNull();
  });

  it('counts only the rows that belong to the caller', async () => {
    const { app, a, b } = await boot();
    await lead(app, b.userId);
    await withBody(app, b.userId);

    expect(await previewPurge(app.db, ctxOf(a.userId))).toMatchObject({
      discoveryResults: 0,
      mailBodies: 0,
    });
  });
});

describe('purgeDiscoveryContent', () => {
  it('keeps the company and the role, and drops everything else it was told', async () => {
    const { app, a } = await boot();
    const id = await lead(app, a.userId);

    expect(await purgeDiscoveryContent(app.db, ctxOf(a.userId))).toBe(1);

    const row = await leadById(app, a.userId, id);
    // Brian's rule for a discovery record: it says which company and which role, and the rest
    // of it lives at the source.
    expect(row.posting).toEqual({ company: 'Northwind Systems', title: 'Staff Engineer' });
    expect(row.aiRationale).toBeNull();
    // The score is the app's own judgement, not content, and the queue sorts by it.
    expect(row.aiScore).toBe(70);
  });

  it('never touches a lead the user accepted', async () => {
    const { app, a } = await boot();
    const accepted = await lead(app, a.userId, { disposition: 'accepted' });

    expect(await purgeDiscoveryContent(app.db, ctxOf(a.userId))).toBe(0);

    expect((await leadById(app, a.userId, accepted)).aiRationale).not.toBeNull();
  });

  it('keeps the dedupe key, so a purged lead does not come back on the next sync', async () => {
    const { app, a } = await boot();
    const id = await lead(app, a.userId);

    await purgeDiscoveryContent(app.db, ctxOf(a.userId));

    expect((await leadById(app, a.userId, id)).dedupeKey).not.toBeNull();
  });

  it('leaves another user alone', async () => {
    const { app, a, b } = await boot();
    const theirs = await lead(app, b.userId);

    await purgeDiscoveryContent(app.db, ctxOf(a.userId));

    expect((await leadById(app, b.userId, theirs)).aiRationale).not.toBeNull();
  });
});

describe('purgeMailBodies', () => {
  it('deletes the file and clears the pointer, keeping the row', async () => {
    const { app, a } = await boot();
    const { id, bodyRef } = await withBody(app, a.userId);

    expect(await purgeMailBodies(app.db, ctxOf(a.userId), app.storage)).toMatchObject({
      cleared: 1,
      deleted: 1,
      skipped: 0,
    });

    const row = await commById(app, a.userId, id);
    expect(row.bodyRef).toBeNull();
    expect(row.subject).toBe('Next steps');
    expect(await fileExists(app, bodyRef)).toBe(false);
  });

  it('leaves a body an unfinished job is still going to read', async () => {
    // Review Focus 3. A classify job enqueued before Plan 3 carries no body in its payload and
    // falls back to the stored file, so deleting it mid-flight would classify a message on its
    // snippet alone, or fail the job outright.
    const { app, a } = await boot();
    const { id, bodyRef } = await withBody(app, a.userId);
    const now = Date.now();
    await app.db
      .insert(jobs)
      .values({
        id: newId(),
        kind: CLASSIFY_JOB_KIND,
        payload: { communicationId: id },
        runAt: now,
        attempts: 0,
        maxAttempts: 3,
        status: 'pending',
        dedupeKey: classifyDedupeKey(id),
        userId: a.userId,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    expect(await purgeMailBodies(app.db, ctxOf(a.userId), app.storage)).toMatchObject({
      cleared: 0,
      skipped: 1,
    });

    expect((await commById(app, a.userId, id)).bodyRef).toBe(bodyRef);
    expect(await fileExists(app, bodyRef)).toBe(true);
  });

  it('keeps a file another row still points at, and clears only its own pointer', async () => {
    // Storage is content addressed, so two identical messages share one file. Deleting it
    // because one row was purged would leave the other row pointing at nothing.
    const { app, a, b } = await boot();
    const same = 'Two people were sent the same message.';
    const mine = await withBody(app, a.userId, same);
    const theirs = await withBody(app, b.userId, same);
    expect(mine.bodyRef).toBe(theirs.bodyRef);

    const out = await purgeMailBodies(app.db, ctxOf(a.userId), app.storage);

    expect(out).toMatchObject({ cleared: 1, deleted: 0, shared: 1 });
    expect((await commById(app, a.userId, mine.id)).bodyRef).toBeNull();
    expect((await commById(app, b.userId, theirs.id)).bodyRef).toBe(theirs.bodyRef);
    expect(await fileExists(app, theirs.bodyRef)).toBe(true);
  });

  it('is safe to run twice', async () => {
    const { app, a } = await boot();
    await withBody(app, a.userId);

    await purgeMailBodies(app.db, ctxOf(a.userId), app.storage);

    expect(await purgeMailBodies(app.db, ctxOf(a.userId), app.storage)).toMatchObject({
      cleared: 0,
      deleted: 0,
    });
  });
});

/** A pending classify job for a row, the shape a stuck pre-#59 LinkedIn import left behind. */
async function blockingClassifyJob(app: FastifyInstance, userId: string, commId: string) {
  const now = Date.now();
  const id = newId();
  await app.db
    .insert(jobs)
    .values({
      id,
      kind: CLASSIFY_JOB_KIND,
      payload: { communicationId: commId },
      runAt: now,
      attempts: 0,
      maxAttempts: 3,
      status: 'pending',
      dedupeKey: classifyDedupeKey(commId),
      userId,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

const jobStatus = async (app: FastifyInstance, id: string) =>
  (await app.db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, id)).get())?.status;

describe('drainBlockingClassifyJobs (issue #66)', () => {
  it('dead-letters the pending job holding a body back, and a later purge clears it', async () => {
    const { app, a } = await boot();
    const { id, bodyRef } = await withBody(app, a.userId);
    const jobId = await blockingClassifyJob(app, a.userId, id);

    expect(await drainBlockingClassifyJobs(app.db, ctxOf(a.userId))).toEqual({
      cancelled: 1,
      stillBlocked: [],
    });
    expect(await jobStatus(app, jobId)).toBe('dead');

    // Unchanged purgeMailBodies now proceeds on its own: nothing about it had to change.
    expect(await purgeMailBodies(app.db, ctxOf(a.userId), app.storage)).toMatchObject({
      cleared: 1,
      deleted: 1,
      skipped: 0,
    });
    expect((await commById(app, a.userId, id)).bodyRef).toBeNull();
    expect(await fileExists(app, bodyRef)).toBe(false);
  });

  it('does nothing when nothing is blocked', async () => {
    const { app, a } = await boot();
    await withBody(app, a.userId);

    expect(await drainBlockingClassifyJobs(app.db, ctxOf(a.userId))).toEqual({
      cancelled: 0,
      stillBlocked: [],
    });
  });

  it("leaves another user's blocking job alone, and does not report it as this user's problem", async () => {
    const { app, a, b } = await boot();
    const { id } = await withBody(app, b.userId);
    const jobId = await blockingClassifyJob(app, b.userId, id);

    expect(await drainBlockingClassifyJobs(app.db, ctxOf(a.userId))).toEqual({
      cancelled: 0,
      stillBlocked: [],
    });

    expect(await jobStatus(app, jobId)).toBe('pending');
  });

  it('leaves a running job alone and reports it as still blocked, by id and status, rather than reporting success', async () => {
    const { app, a } = await boot();
    const { id, bodyRef } = await withBody(app, a.userId);
    const jobId = await blockingClassifyJob(app, a.userId, id);
    await app.db
      .update(jobs)
      .set({ status: 'running', lockedBy: 'worker-1' })
      .where(eq(jobs.id, jobId))
      .run();

    expect(await drainBlockingClassifyJobs(app.db, ctxOf(a.userId))).toEqual({
      cancelled: 0,
      stillBlocked: [{ id: jobId, status: 'running' }],
    });

    expect(await jobStatus(app, jobId)).toBe('running');
    expect(await fileExists(app, bodyRef)).toBe(true);
  });
});

// The routes, because a purge the user cannot reach is not a feature, and one they can trigger
// by accident is a liability.
describe('POST /communications/purge', () => {
  it('refuses without the typed confirmation, and changes nothing', async () => {
    const { app, a } = await boot();
    const id = await lead(app, a.userId);

    const res = await a.request({
      method: 'POST',
      url: '/api/v1/communications/purge',
      payload: { what: 'both', confirm: 'yes' },
    });

    expect(res.statusCode, res.body).toBe(400);
    expect((await leadById(app, a.userId, id)).aiRationale).not.toBeNull();
  });

  it('purges what the user asked for, and nothing else', async () => {
    const { app, a } = await boot();
    const id = await lead(app, a.userId);
    const { bodyRef } = await withBody(app, a.userId);

    const res = await a.request({
      method: 'POST',
      url: '/api/v1/communications/purge',
      payload: { what: 'discovery', confirm: 'PURGE' },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ discoveryResults: 1, mailBodies: { cleared: 0 } });
    expect((await leadById(app, a.userId, id)).aiRationale).toBeNull();
    // Mail was not in scope, so its body is still there.
    expect(await fileExists(app, bodyRef)).toBe(true);
  });

  it('records the purge as counts, never as what was purged', async () => {
    const { app, a } = await boot();
    await lead(app, a.userId);

    await a.request({
      method: 'POST',
      url: '/api/v1/communications/purge',
      payload: { what: 'both', confirm: 'PURGE' },
    });

    const entries = await app.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'mail.purged'))
      .all();
    expect(entries).toHaveLength(1);
    const detail = JSON.stringify(entries[0]!.detail);
    expect(detail).toContain('discoveryResults');
    expect(detail).not.toContain('Northwind');
  });

  it('previews without changing anything, and says how long backups keep it', async () => {
    const { app, a } = await boot();
    await lead(app, a.userId);

    const res = await a.request({ method: 'GET', url: '/api/v1/communications/purge-preview' });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ discoveryResults: 1, backupRetentionDays: 14 });
  });

  it('still leaves a stuck body alone when drainBlocked is not set (issue #66)', async () => {
    const { app, a } = await boot();
    const { id, bodyRef } = await withBody(app, a.userId);
    await blockingClassifyJob(app, a.userId, id);

    const res = await a.request({
      method: 'POST',
      url: '/api/v1/communications/purge',
      payload: { what: 'mail_bodies', confirm: 'PURGE' },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ mailBodies: { cleared: 0, skipped: 1 } });
    expect(await fileExists(app, bodyRef)).toBe(true);
  });

  it('drainBlocked cancels the stuck classify job and clears the body it was holding (issue #66)', async () => {
    const { app, a } = await boot();
    const { id, bodyRef } = await withBody(app, a.userId);
    const jobId = await blockingClassifyJob(app, a.userId, id);

    const res = await a.request({
      method: 'POST',
      url: '/api/v1/communications/purge',
      payload: { what: 'mail_bodies', confirm: 'PURGE', drainBlocked: true },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      jobsDrained: 1,
      mailBodies: { cleared: 1, deleted: 1, skipped: 0 },
    });
    expect(await jobStatus(app, jobId)).toBe('dead');
    expect((await commById(app, a.userId, id)).bodyRef).toBeNull();
    expect(await fileExists(app, bodyRef)).toBe(false);
  });

  it('drainBlocked reports a running job as still blocked rather than claiming success (issue #66, design principle 6)', async () => {
    const { app, a } = await boot();
    const { id, bodyRef } = await withBody(app, a.userId);
    const jobId = await blockingClassifyJob(app, a.userId, id);
    await app.db
      .update(jobs)
      .set({ status: 'running', lockedBy: 'worker-1' })
      .where(eq(jobs.id, jobId))
      .run();

    const res = await a.request({
      method: 'POST',
      url: '/api/v1/communications/purge',
      payload: { what: 'mail_bodies', confirm: 'PURGE', drainBlocked: true },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      jobsDrained: 0,
      jobsStillBlocked: [{ id: jobId, status: 'running' }],
      mailBodies: { cleared: 0, skipped: 1 },
    });
    expect(await jobStatus(app, jobId)).toBe('running');
    expect(await fileExists(app, bodyRef)).toBe(true);
  });

  it('drainBlocked does nothing for a discovery-only purge', async () => {
    const { app, a } = await boot();
    const { id, bodyRef } = await withBody(app, a.userId);
    const jobId = await blockingClassifyJob(app, a.userId, id);

    const res = await a.request({
      method: 'POST',
      url: '/api/v1/communications/purge',
      payload: { what: 'discovery', confirm: 'PURGE', drainBlocked: true },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ jobsDrained: 0 });
    expect(await jobStatus(app, jobId)).toBe('pending');
    expect(await fileExists(app, bodyRef)).toBe(true);
  });
});
