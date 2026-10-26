// One-shot repair of dedupe keys computed before the non-Latin location fallback existed
// (issue #13). Two distinct non-Latin locations at the same company and title collapsed to the
// same key under the pre-fix formula ("acme|pm|", location normalizing to empty either way);
// this corrects stored keys to the fallback formula in packages/core/src/dedupe.ts.
import { dedupeKey, type NormalizedPosting } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { discoveryResults, jobs, opportunities } from '../src/db/schema';
import {
  enqueueRepairDedupeKeysOnce,
  REPAIR_DEDUPE_KEYS_KIND,
  repairDedupeKeys,
} from '../src/jobs/repairDedupeKeys';
import { createRun, ensureChannelSource, insertResult } from '../src/repos/discovery';
import { createOpportunity } from '../src/repos/opportunities';
import { useApi } from './api';

const boot = useApi();

/** What the pre-fix formula produced: location normalized to empty either way, no fallback. */
const OLD_COLLAPSED_KEY = 'acme|pm|';

const oppById = async (app: FastifyInstance, userId: string, id: string) =>
  (await app.db
    .select()
    .from(opportunities)
    .where(and(eq(opportunities.userId, userId), eq(opportunities.id, id)))
    .get())!;

const resultById = async (app: FastifyInstance, userId: string, id: string) =>
  (await app.db
    .select()
    .from(discoveryResults)
    .where(and(eq(discoveryResults.userId, userId), eq(discoveryResults.id, id)))
    .get())!;

describe('repairDedupeKeys: opportunities', () => {
  it('corrects a key stored under the pre-fallback formula to the hash-fallback one', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Acme',
      title: 'PM',
      location: '東京',
      sourceKind: 'manual',
    });
    // Simulate a row stored before the fix: downgrade the already-correct key to what the
    // pre-fallback formula would have produced for this same location.
    await app.db
      .update(opportunities)
      .set({ dedupeKey: OLD_COLLAPSED_KEY })
      .where(eq(opportunities.id, opp.id))
      .run();

    const outcome = await repairDedupeKeys(app.db, ctx);

    expect(outcome.opportunities).toEqual({ scanned: 1, corrected: 1 });
    const row = await oppById(app, a.userId, opp.id);
    expect(row.dedupeKey).toBe(dedupeKey('Acme', 'PM', '東京'));
    expect(row.dedupeKey).not.toBe(OLD_COLLAPSED_KEY);
  });

  it('leaves an already-correct key untouched', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Acme',
      title: 'PM',
      location: 'Remote',
      sourceKind: 'manual',
    });
    const before = await oppById(app, a.userId, opp.id);

    const outcome = await repairDedupeKeys(app.db, ctx);

    const after = await oppById(app, a.userId, opp.id);
    expect(after.dedupeKey).toBe(before.dedupeKey);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(outcome.opportunities).toEqual({ scanned: 1, corrected: 0 });
  });

  it('does not resurrect a null key (force-created past a duplicate stays opted out)', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    const opp = await createOpportunity(app.db, ctx, {
      companyName: 'Acme',
      title: 'PM',
      location: '東京',
      sourceKind: 'manual',
    });
    await app.db
      .update(opportunities)
      .set({ dedupeKey: null })
      .where(eq(opportunities.id, opp.id))
      .run();

    const outcome = await repairDedupeKeys(app.db, ctx);

    expect((await oppById(app, a.userId, opp.id)).dedupeKey).toBeNull();
    // Not scanned at all: the repair only looks at rows that already have a key.
    expect(outcome.opportunities.scanned).toBe(0);
  });
});

describe('repairDedupeKeys: discovery results', () => {
  async function seedResult(app: FastifyInstance, userId: string, posting: NormalizedPosting) {
    const ctx = { userId, isAdmin: false };
    const source = await ensureChannelSource(app.db, ctx, 'alert_email');
    const run = await createRun(app.db, ctx, { sourceId: source.id });
    return await insertResult(app.db, ctx, {
      runId: run.id,
      posting,
      dedupeKey: OLD_COLLAPSED_KEY,
      resolution: 'needs_capture',
    });
  }

  it('disambiguates two non-Latin locations that collided under the old formula', async () => {
    // The actual consequence of issue #13: two real, different postings, both stored with the
    // same collapsed key because discovery_results has no uniqueness constraint to catch it.
    const { app, a } = await boot();
    const tokyo = await seedResult(app, a.userId, {
      title: 'PM',
      company: 'Acme',
      location: '東京',
      remote: null,
      descriptionMd: null,
      postingUrl: 'https://jobs.example/1',
    });
    const osaka = await seedResult(app, a.userId, {
      title: 'PM',
      company: 'Acme',
      location: '大阪',
      remote: null,
      descriptionMd: null,
      postingUrl: 'https://jobs.example/2',
    });

    const outcome = await repairDedupeKeys(app.db, { userId: a.userId, isAdmin: false });

    expect(outcome.discoveryResults).toEqual({ scanned: 2, corrected: 2 });
    const tokyoRow = await resultById(app, a.userId, tokyo.id);
    const osakaRow = await resultById(app, a.userId, osaka.id);
    expect(tokyoRow.dedupeKey).toBe(dedupeKey('Acme', 'PM', '東京'));
    expect(osakaRow.dedupeKey).toBe(dedupeKey('Acme', 'PM', '大阪'));
    expect(tokyoRow.dedupeKey).not.toBe(osakaRow.dedupeKey);
  });

  it('leaves an already-correct result key untouched', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    const source = await ensureChannelSource(app.db, ctx, 'alert_email');
    const run = await createRun(app.db, ctx, { sourceId: source.id });
    const posting: NormalizedPosting = {
      title: 'PM',
      company: 'Acme',
      location: 'Remote',
      remote: true,
      descriptionMd: null,
      postingUrl: 'https://jobs.example/3',
    };
    const result = await insertResult(app.db, ctx, {
      runId: run.id,
      posting,
      dedupeKey: dedupeKey('Acme', 'PM', 'Remote'),
      resolution: 'needs_capture',
    });
    const before = await resultById(app, a.userId, result.id);

    const outcome = await repairDedupeKeys(app.db, ctx);

    const after = await resultById(app, a.userId, result.id);
    expect(after.dedupeKey).toBe(before.dedupeKey);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(outcome.discoveryResults).toEqual({ scanned: 1, corrected: 0 });
  });
});

describe('enqueueRepairDedupeKeysOnce', () => {
  const repairJobs = async (app: FastifyInstance) =>
    app.db.select().from(jobs).where(eq(jobs.kind, REPAIR_DEDUPE_KEYS_KIND)).all();

  it('does not retire the repair when the install has no users yet', async () => {
    const { app } = await boot();
    expect(await repairJobs(app)).toHaveLength(0);

    const queued = await enqueueRepairDedupeKeysOnce(app.db);
    expect(queued).toBe(2); // the two users registered after boot
    expect(await repairJobs(app)).toHaveLength(2);
  });

  it('never queues the repair twice', async () => {
    const { app } = await boot();
    await enqueueRepairDedupeKeysOnce(app.db);

    const second = await enqueueRepairDedupeKeysOnce(app.db);

    expect(second).toBe(0);
    expect(await repairJobs(app)).toHaveLength(2);
  });
});
