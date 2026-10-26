// Issue #101: a Workday posting stored bare after a failed detail fetch was never retried by
// anything, because both the normal discovery run and lead-resolve's recovery path went through
// the same known.has(id) short-circuit in workdaySource.fetchPostings. This is the dedicated
// retry path that does not touch that generator at all.
import { dedupeKey, type NormalizedPosting } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { discoveryResults } from '../src/db/schema';
import {
  CAPTURE_RETRY_MAX_AGE_MS,
  CAPTURE_RETRY_MAX_PER_HOST_PER_RUN,
  retryWorkdayCapture,
} from '../src/jobs/retryWorkdayCapture';
import { createRun, ensureChannelSource, insertResult } from '../src/repos/discovery';
import { useApi } from './api';

const boot = useApi();
const ctxOf = (userId: string) => ({ userId, isAdmin: false });

const HOST = 'initech.wd5.myworkdayjobs.com';
const EXTERNAL_PATH = '/job/Milpitas-California-US/Product-Manager_1000001';
const POSTING_URL = `https://${HOST}/Initech_Careers${EXTERNAL_PATH}`;
const DETAIL_URL = `https://${HOST}/wday/cxs/initech/Initech_Careers${EXTERNAL_PATH}`;

const BARE: NormalizedPosting = {
  company: 'Initech',
  title: 'Product Manager',
  descriptionMd: null,
  postingUrl: POSTING_URL,
  location: 'Milpitas, CA',
  remote: null,
  compNote: null,
  externalId: '1000001',
  postedAt: null,
};

const log = { warn: () => undefined };

/** A fake transport that answers one fixed URL and records every call made to it. */
function fakeFetch(detailReply: { status: number; body: string } | null) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    if (url !== DETAIL_URL || detailReply === null) {
      return { status: 404, headers: new Headers(), body: Buffer.from('{}'), url };
    }
    return {
      status: detailReply.status,
      headers: new Headers(),
      body: Buffer.from(detailReply.body),
      url,
    };
  };
  return { calls, fetch: fetch as unknown as Parameters<typeof retryWorkdayCapture>[1]['fetch'] };
}

async function seedBare(
  app: FastifyInstance,
  userId: string,
  posting: NormalizedPosting = BARE,
): Promise<string> {
  const ctx = ctxOf(userId);
  const source = await ensureChannelSource(app.db, ctx, 'manual');
  const run = await createRun(app.db, ctx, { sourceId: source.id });
  const result = await insertResult(app.db, ctx, {
    runId: run.id,
    posting,
    dedupeKey: dedupeKey(posting.company, posting.title, posting.location),
    resolution: 'needs_capture',
  });
  return result.id;
}

const rowById = async (app: FastifyInstance, userId: string, id: string) =>
  (await app.db
    .select()
    .from(discoveryResults)
    .where(and(eq(discoveryResults.userId, userId), eq(discoveryResults.id, id)))
    .get())!;

const DETAIL_BODY = JSON.stringify({
  jobPostingInfo: {
    title: 'Product Manager',
    jobDescription: '<p>The full description, finally available.</p>',
    location: 'Milpitas, California, US',
    remoteType: 'On-Site',
    startDate: '2026-01-05',
  },
  hiringOrganization: { name: 'Initech Systems' },
});

describe('retryWorkdayCapture', () => {
  it('describes a still-bare posting whose detail fetch now succeeds', async () => {
    const { app, a } = await boot();
    const id = await seedBare(app, a.userId);
    const { calls, fetch } = fakeFetch({ status: 200, body: DETAIL_BODY });

    const outcome = await retryWorkdayCapture(app.db, { fetch, log });

    expect(outcome).toEqual({ scanned: 1, described: 1, abandoned: 0 });
    expect(calls).toEqual([DETAIL_URL]);
    const row = await rowById(app, a.userId, id);
    expect(row.resolution).toBe('full');
    expect(row.posting).toMatchObject({
      // sanitizePosting strips markup, same as every other discovery writer.
      descriptionMd: 'The full description, finally available.',
      company: 'Initech Systems',
      // The row's own identity is kept, not whatever the detail response would derive.
      externalId: '1000001',
    });
    expect(row.dedupeKey).toBe(
      dedupeKey('Initech Systems', 'Product Manager', row.posting.location as string),
    );
  });

  it('leaves a row untouched when the detail fetch is still failing', async () => {
    const { app, a } = await boot();
    const id = await seedBare(app, a.userId);
    const before = await rowById(app, a.userId, id);
    const { fetch } = fakeFetch(null); // 404: still gone or unusable.

    const outcome = await retryWorkdayCapture(app.db, { fetch, log });

    expect(outcome).toEqual({ scanned: 1, described: 0, abandoned: 0 });
    const after = await rowById(app, a.userId, id);
    expect(after.resolution).toBe('needs_capture');
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.posting).toEqual(before.posting);
  });

  it('moves a row past the age bound to capture_failed, without a fetch (issue #101)', async () => {
    const { app, a } = await boot();
    const id = await seedBare(app, a.userId);
    const before = await rowById(app, a.userId, id);
    await app.db
      .update(discoveryResults)
      .set({ createdAt: Date.now() - CAPTURE_RETRY_MAX_AGE_MS - 1 })
      .where(eq(discoveryResults.id, id))
      .run();
    const { calls, fetch } = fakeFetch({ status: 200, body: DETAIL_BODY });

    const outcome = await retryWorkdayCapture(app.db, { fetch, log });

    expect(outcome).toEqual({ scanned: 0, described: 0, abandoned: 1 });
    expect(calls).toEqual([]); // Abandoning a row costs no network call.
    const after = await rowById(app, a.userId, id);
    expect(after.resolution).toBe('capture_failed');
    // Distinguishable from a row nobody has tried yet, not just dropped from future sweeps:
    // the posting itself (still bare) is untouched, only resolution and updatedAt move.
    expect(after.posting).toEqual(before.posting);
  });

  it('retries a row just inside the age bound', async () => {
    const { app, a } = await boot();
    const id = await seedBare(app, a.userId);
    await app.db
      .update(discoveryResults)
      .set({ createdAt: Date.now() - CAPTURE_RETRY_MAX_AGE_MS + 60_000 })
      .where(eq(discoveryResults.id, id))
      .run();
    const { fetch } = fakeFetch({ status: 200, body: DETAIL_BODY });

    const outcome = await retryWorkdayCapture(app.db, { fetch, log });

    expect(outcome).toEqual({ scanned: 1, described: 1, abandoned: 0 });
    expect((await rowById(app, a.userId, id)).resolution).toBe('full');
  });

  it('never retries an already-abandoned (capture_failed) row again', async () => {
    const { app, a } = await boot();
    const ctx = ctxOf(a.userId);
    const source = await ensureChannelSource(app.db, ctx, 'manual');
    const run = await createRun(app.db, ctx, { sourceId: source.id });
    const result = await insertResult(app.db, ctx, {
      runId: run.id,
      posting: BARE,
      dedupeKey: dedupeKey(BARE.company, BARE.title, BARE.location),
      resolution: 'needs_capture',
    });
    await app.db
      .update(discoveryResults)
      .set({ resolution: 'capture_failed' })
      .where(eq(discoveryResults.id, result.id))
      .run();
    const { calls, fetch } = fakeFetch({ status: 200, body: DETAIL_BODY });

    const outcome = await retryWorkdayCapture(app.db, { fetch, log });

    expect(outcome).toEqual({ scanned: 0, described: 0, abandoned: 0 });
    expect(calls).toEqual([]);
  });

  it('ignores a needs_capture row that is not a Workday posting', async () => {
    const { app, a } = await boot();
    const greenhousePosting: NormalizedPosting = {
      ...BARE,
      postingUrl: 'https://job-boards.greenhouse.io/initech/jobs/5550001001',
    };
    const id = await seedBare(app, a.userId, greenhousePosting);
    const { calls, fetch } = fakeFetch({ status: 200, body: DETAIL_BODY });

    const outcome = await retryWorkdayCapture(app.db, { fetch, log });

    expect(outcome).toEqual({ scanned: 0, described: 0, abandoned: 0 });
    expect(calls).toEqual([]);
    expect((await rowById(app, a.userId, id)).resolution).toBe('needs_capture');
  });

  it('ignores an already-described (full) row', async () => {
    const { app, a } = await boot();
    const described: NormalizedPosting = { ...BARE, descriptionMd: 'Already here.' };
    const ctx = ctxOf(a.userId);
    const source = await ensureChannelSource(app.db, ctx, 'manual');
    const run = await createRun(app.db, ctx, { sourceId: source.id });
    await insertResult(app.db, ctx, {
      runId: run.id,
      posting: described,
      dedupeKey: dedupeKey(described.company, described.title, described.location),
      resolution: 'full',
    });
    const { calls, fetch } = fakeFetch({ status: 200, body: DETAIL_BODY });

    const outcome = await retryWorkdayCapture(app.db, { fetch, log });

    expect(outcome).toEqual({ scanned: 0, described: 0, abandoned: 0 });
    expect(calls).toEqual([]);
  });

  it('continues past one row whose fetch throws, and still retries the rest', async () => {
    const { app, a } = await boot();
    const id1 = await seedBare(app, a.userId, BARE);
    const other: NormalizedPosting = {
      ...BARE,
      externalId: '9999999',
      postingUrl: `https://${HOST}/Initech_Careers/job/Remote/Other-Role_9999999`,
    };
    const id2 = await seedBare(app, a.userId, other);
    let calls = 0;
    const fetch = (async (url: string) => {
      calls += 1;
      if (url.endsWith('1000001')) throw new Error('network blip');
      return { status: 200, headers: new Headers(), body: Buffer.from(DETAIL_BODY), url };
    }) as unknown as Parameters<typeof retryWorkdayCapture>[1]['fetch'];

    const outcome = await retryWorkdayCapture(app.db, { fetch, log });

    expect(calls).toBe(2);
    expect(outcome).toEqual({ scanned: 2, described: 1, abandoned: 0 });
    expect((await rowById(app, a.userId, id1)).resolution).toBe('needs_capture');
    expect((await rowById(app, a.userId, id2)).resolution).toBe('full');
  });

  it('caps detail fetches per host per run, leaving the rest for tomorrow (issue #20/#101)', async () => {
    const { app, a } = await boot();
    const n = CAPTURE_RETRY_MAX_PER_HOST_PER_RUN + 3;
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const posting: NormalizedPosting = {
        ...BARE,
        externalId: `req-${i}`,
        postingUrl: `https://${HOST}/Initech_Careers/job/Remote/Role-${i}_req-${i}`,
      };
      ids.push(await seedBare(app, a.userId, posting));
    }
    let calls = 0;
    const fetch = (async (url: string) => {
      calls += 1;
      return { status: 200, headers: new Headers(), body: Buffer.from(DETAIL_BODY), url };
    }) as unknown as Parameters<typeof retryWorkdayCapture>[1]['fetch'];

    const outcome = await retryWorkdayCapture(app.db, { fetch, log });

    expect(calls).toBe(CAPTURE_RETRY_MAX_PER_HOST_PER_RUN);
    expect(outcome).toEqual({
      scanned: CAPTURE_RETRY_MAX_PER_HOST_PER_RUN,
      described: CAPTURE_RETRY_MAX_PER_HOST_PER_RUN,
      abandoned: 0,
    });
    const resolutions = await Promise.all(ids.map((id) => rowById(app, a.userId, id)));
    const stillBare = resolutions.filter((r) => r.resolution === 'needs_capture');
    expect(stillBare).toHaveLength(3); // Left for the next run, not dropped or failed.
  });
});
