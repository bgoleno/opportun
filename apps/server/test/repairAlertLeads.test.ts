// One-shot repair of discovery leads whose fields were shifted by the pre-fix LinkedIn parser
// (15 rows live, 2026-10-19). The digest header sat directly above the first job, so the block
// walk absorbed it and every field moved down one. The repair re-parses the source digest
// rather than shuffling columns: the shifted rows' dedupe keys were built from shifted values,
// so a shuffle leaves keys that will not match what the fixed parser produces for the same job.
import { dedupeKey, type NormalizedPosting } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { discoveryResults, jobs } from '../src/db/schema';
import {
  enqueueRepairAlertLeadsOnce,
  REPAIR_ALERT_LEADS_KIND,
  repairAlertLeads,
} from '../src/jobs/repairAlertLeads';
import { createRun, ensureChannelSource, insertResult } from '../src/repos/discovery';
import { upsertInbound } from '../src/repos/communications';
import { storeBodyFor } from './storedBody';
import { useApi } from './api';

const boot = useApi();

const DIGEST = [
  'Your job alert for product manager in United States',
  'Principal Product Manager, Data Platform Governance',
  'The Walt Disney Company',
  'Burbank, CA',
  'View job: https://www.linkedin.com/comm/jobs/view/4479334176/',
  '',
  'Staff Product Manager, Observability',
  'Render',
  'Remote',
  'View job: https://www.linkedin.com/comm/jobs/view/4442934507/',
].join('\n');

/** What the pre-fix parser stored for the first job: every field shifted down by one. */
const SHIFTED: NormalizedPosting = {
  title: 'Your job alert for product manager in United States',
  company: 'Principal Product Manager, Data Platform Governance',
  location: 'The Walt Disney Company',
  remote: null,
  descriptionMd: null,
  postingUrl: 'https://www.linkedin.com/jobs/view/4479334176/',
  externalId: '4479334176',
};

/** The second job in the same digest parsed correctly even before the fix (blank line above). */
const CORRECT: NormalizedPosting = {
  title: 'Staff Product Manager, Observability',
  company: 'Render',
  location: 'Remote',
  remote: true,
  descriptionMd: null,
  postingUrl: 'https://www.linkedin.com/jobs/view/4442934507/',
  externalId: '4442934507',
};

async function seed(app: FastifyInstance, userId: string) {
  const ctx = { userId, isAdmin: false };
  const { id: digestId } = await upsertInbound(app.db, ctx, 'gmail', {
    externalId: 'digest-1',
    threadKey: 'digest-1',
    from: 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>',
    to: ['me@example.com'],
    subject: '"product manager": 2 new jobs',
    snippet: DIGEST.slice(0, 80),
    bodyText: DIGEST,
    sentAt: Date.now() - 5000,
  });
  // The repair job re-parses a digest from the body on disk, which only a message stored before
  // issue #53 has.
  await storeBodyFor(app, userId, digestId, DIGEST);
  const source = await ensureChannelSource(app.db, ctx, 'alert_email');
  const run = await createRun(app.db, ctx, { sourceId: source.id });
  const shifted = await insertResult(app.db, ctx, {
    runId: run.id,
    posting: SHIFTED,
    dedupeKey: dedupeKey(SHIFTED.company, SHIFTED.title, SHIFTED.location),
    resolution: 'needs_capture',
  });
  const correct = await insertResult(app.db, ctx, {
    runId: run.id,
    posting: CORRECT,
    dedupeKey: dedupeKey(CORRECT.company, CORRECT.title, CORRECT.location),
    resolution: 'needs_capture',
  });
  return { ctx, shiftedId: shifted.id, correctId: correct.id };
}

const rowById = async (app: FastifyInstance, userId: string, id: string) =>
  (await app.db
    .select()
    .from(discoveryResults)
    .where(and(eq(discoveryResults.userId, userId), eq(discoveryResults.id, id)))
    .get())!;

describe('repairAlertLeads', () => {
  it('re-parses the digest so the shifted row carries the real title, company and location', async () => {
    const { app, a } = await boot();
    const { ctx, shiftedId } = await seed(app, a.userId);

    const outcome = await repairAlertLeads(app.db, ctx, app.storage);
    expect(outcome.repaired).toBe(1);

    const row = await rowById(app, a.userId, shiftedId);
    expect(row.posting).toMatchObject({
      title: 'Principal Product Manager, Data Platform Governance',
      company: 'The Walt Disney Company',
      location: 'Burbank, CA',
      externalId: '4479334176',
    });
  });

  it('recomputes the dedupe key from the corrected values so future digests match', async () => {
    const { app, a } = await boot();
    const { ctx, shiftedId } = await seed(app, a.userId);

    await repairAlertLeads(app.db, ctx, app.storage);

    const row = await rowById(app, a.userId, shiftedId);
    expect(row.dedupeKey).toBe(
      dedupeKey(
        'The Walt Disney Company',
        'Principal Product Manager, Data Platform Governance',
        'Burbank, CA',
      ),
    );
  });

  it('leaves an already-correct row untouched', async () => {
    const { app, a } = await boot();
    const { ctx, correctId } = await seed(app, a.userId);
    const before = await rowById(app, a.userId, correctId);

    const outcome = await repairAlertLeads(app.db, ctx, app.storage);

    const after = await rowById(app, a.userId, correctId);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.posting).toEqual(before.posting);
    expect(outcome.repaired).toBe(1);
  });

  it('counts but does not repair a shifted row whose digest body is gone', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    const source = await ensureChannelSource(app.db, ctx, 'alert_email');
    const run = await createRun(app.db, ctx, { sourceId: source.id });
    const orphan = await insertResult(app.db, ctx, {
      runId: run.id,
      posting: SHIFTED,
      dedupeKey: dedupeKey(SHIFTED.company, SHIFTED.title, SHIFTED.location),
      resolution: 'needs_capture',
    });

    const outcome = await repairAlertLeads(app.db, ctx, app.storage);

    expect(outcome.scanned).toBe(1);
    expect(outcome.repaired).toBe(0);
    expect((await rowById(app, a.userId, orphan.id)).posting).toEqual(SHIFTED);
  });
});

describe('enqueueRepairAlertLeadsOnce', () => {
  const repairJobs = async (app: FastifyInstance) =>
    app.db.select().from(jobs).where(eq(jobs.kind, REPAIR_ALERT_LEADS_KIND)).all();

  it('does not retire the repair when the install has no users yet', async () => {
    // The app boots before anyone registers, so boot itself must enqueue nothing and leave the
    // marker unwritten. Marking it done here would retire the repair having done no work.
    const { app } = await boot();
    expect(await repairJobs(app)).toHaveLength(0);

    const queued = await enqueueRepairAlertLeadsOnce(app.db);
    expect(queued).toBe(2); // the two users registered after boot
    expect(await repairJobs(app)).toHaveLength(2);
  });

  it('never queues the repair twice', async () => {
    const { app } = await boot();
    await enqueueRepairAlertLeadsOnce(app.db);

    const second = await enqueueRepairAlertLeadsOnce(app.db);

    expect(second).toBe(0);
    expect(await repairJobs(app)).toHaveLength(2);
  });
});
