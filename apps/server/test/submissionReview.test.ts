// The review gate and the handoff (assisted apply M1c,
// https://github.com/bgoleno/opportun/issues/116; design Part A 3.4, 4.3, 4.5, 6.1, 7.4 to 7.6).
// Organised by the issue's acceptance criteria. Every opportunity, resume and answer here is
// synthetic. Opportun never transmits an application: the destination is returned to the
// browser, never fetched (criterion 4 records every outbound request to prove it).
import { newId, type AtsJobRef } from '@opportun/core';
import { and, count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  activities,
  applicationSubmissions,
  auditLog,
  jobs,
  opportunities,
  resumes,
  stageHistory,
} from '../src/db/schema';
import { enqueue, runDueJobs } from '../src/jobs/runner';
import { setRaceHook } from '../src/lib/racePoints';
import type { safeFetch } from '../src/lib/safeFetch';
import type { UserCtx } from '../src/repos/base';
import { createOpportunity } from '../src/repos/opportunities';
import { insertResume } from '../src/repos/resumes';
import { writeUserSetting } from '../src/repos/userSettings';
import {
  DAILY_REVIEW_CAP_SETTING,
  HANDOFF_IDLE_MS,
  REVIEW_TTL_MS,
  SUBMISSION_EXPIRE_JOB_KIND,
} from '../src/repos/submissionReview';
import { useApi } from './api';
import { captureLogs } from './helpers';
import type { TestClient } from './isolation';
import { holdAt } from './race';

const logs = captureLogs();
const boot = useApi(() => ({ logStream: logs }));
const ON = { submissions: true };
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });

const ATS_REF: AtsJobRef = {
  kind: 'ats_greenhouse',
  org: 'examplecorp',
  externalId: '1000001',
  url: 'https://boards.greenhouse.io/examplecorp/jobs/1000001',
};

/** A value that must never leave the submission row (criterion 5). */
const SENTINEL = 'SENTINEL-answer-7f3a9c';

async function seedOpportunity(
  app: FastifyInstance,
  c: TestClient,
  ats: AtsJobRef = ATS_REF,
): Promise<string> {
  const opp = await createOpportunity(app.db, ctxOf(c), {
    companyName: 'Example Corp',
    title: `Senior Example Engineer ${newId().slice(-6)}`,
    sourceKind: 'manual',
  });
  await app.db
    .update(opportunities)
    .set({ stage: 'interested', atsJobRef: ats, postingState: 'confirmed' })
    .where(eq(opportunities.id, opp.id))
    .run();
  return opp.id;
}

async function seedResume(app: FastifyInstance, c: TestClient): Promise<string> {
  const r = await insertResume(app.db, ctxOf(c), {
    kind: 'base',
    title: 'Example Resume',
    store: 'local_file',
    docRef: `resumes/${newId()}.txt`,
    opportunityId: null,
    parentResumeId: null,
  });
  await app.db.update(resumes).set({ status: 'final' }).where(eq(resumes.id, r.id)).run();
  return r.id;
}

interface SubmissionJson {
  id: string;
  status: string;
  reviewDigest: string;
  reviewExpiresAt: number | null;
  reviewedAt: number | null;
  handedOffAt: number | null;
  failureReason: string | null;
}

const api = (
  c: TestClient,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  payload?: object,
) => c.request({ method, url: `/api/v1${url}`, ...(payload === undefined ? {} : { payload }) });

/** A draft for a fresh eligible opportunity, with an answer carrying the sentinel. */
async function draft(app: FastifyInstance, c: TestClient, ats: AtsJobRef = ATS_REF) {
  const oppId = await seedOpportunity(app, c, ats);
  const resumeId = await seedResume(app, c);
  const created = await api(c, 'POST', `/opportunities/${oppId}/submissions`, {
    idempotencyKey: crypto.randomUUID(),
    resumeId,
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = (created.json() as SubmissionJson).id;
  const edited = await api(c, 'PATCH', `/submissions/${id}`, {
    fields: { email: 'jane@example.com' },
    answers: [{ question: 'Why us?', answer: SENTINEL }],
  });
  expect(edited.statusCode, edited.body).toBe(200);
  return { oppId, resumeId, id, submission: edited.json() as SubmissionJson };
}

const review = (c: TestClient, id: string, reviewDigest: string, extra: object = {}) =>
  api(c, 'POST', `/submissions/${id}/review`, { reviewDigest, acknowledged: true, ...extra });

const handoff = (c: TestClient, id: string) => api(c, 'POST', `/submissions/${id}/handoff`, {});

async function reviewed(app: FastifyInstance, c: TestClient, ats: AtsJobRef = ATS_REF) {
  const d = await draft(app, c, ats);
  const res = await review(c, d.id, d.submission.reviewDigest);
  expect(res.statusCode, res.body).toBe(200);
  return { ...d, submission: res.json() as SubmissionJson };
}

async function rowOf(app: FastifyInstance, id: string) {
  return await app.db
    .select()
    .from(applicationSubmissions)
    .where(eq(applicationSubmissions.id, id))
    .get();
}

/** Row counts that a refused handoff must leave exactly as they were (criterion 1). */
async function counts(app: FastifyInstance, c: TestClient) {
  const n = async (table: typeof activities | typeof stageHistory | typeof auditLog) =>
    (await app.db.select({ n: count() }).from(table).where(eq(table.userId, c.userId)).get())?.n;
  return {
    activities: await n(activities),
    stageHistory: await n(stageHistory),
    auditLog: await n(auditLog),
  };
}

async function auditEvents(app: FastifyInstance, c: TestClient, event: string) {
  return await app.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.userId, c.userId), eq(auditLog.event, event)))
    .all();
}

describe('the review digest', () => {
  it('is returned on every read, and changes when the fields or answers change', async () => {
    const { app, a } = await boot(ON);
    const d = await draft(app, a);
    expect(d.submission.reviewDigest).toMatch(/^[0-9a-f]{64}$/);

    const read = await api(a, 'GET', `/submissions/${d.id}`);
    expect((read.json() as SubmissionJson).reviewDigest).toBe(d.submission.reviewDigest);

    const edited = await api(a, 'PATCH', `/submissions/${d.id}`, {
      answers: [{ question: 'Why us?', answer: 'something else' }],
    });
    expect((edited.json() as SubmissionJson).reviewDigest).not.toBe(d.submission.reviewDigest);
  });

  it('is the same for the same state, whatever the order of the field keys', async () => {
    const { app, a } = await boot(ON);
    const d = await draft(app, a);
    const one = await api(a, 'PATCH', `/submissions/${d.id}`, { fields: { a: '1', b: '2' } });
    const two = await api(a, 'PATCH', `/submissions/${d.id}`, { fields: { b: '2', a: '1' } });
    expect((one.json() as SubmissionJson).reviewDigest).toBe(
      (two.json() as SubmissionJson).reviewDigest,
    );
  });
});

describe('POST /submissions/:id/review', () => {
  it('reviews a draft whose digest matches: reviewed, with a static valid-until time', async () => {
    const { app, a } = await boot(ON);
    const d = await draft(app, a);
    const before = Date.now();

    const res = await review(a, d.id, d.submission.reviewDigest);

    expect(res.statusCode, res.body).toBe(200);
    const s = res.json() as SubmissionJson;
    expect(s.status).toBe('reviewed');
    expect(s.reviewedAt).toBeGreaterThanOrEqual(before);
    // A timestamp, not a countdown (owner's decision): reviewedAt plus the review's lifetime.
    expect(s.reviewExpiresAt).toBe((s.reviewedAt as number) + REVIEW_TTL_MS);
    expect((await rowOf(app, d.id))?.reviewDigest).toBe(d.submission.reviewDigest);
    const [event] = await auditEvents(app, a, 'submission.reviewed');
    expect(event?.detail).toMatchObject({ submissionId: d.id, opportunityId: d.oppId });
  });

  it('refuses a stale digest with review_stale, and changes nothing', async () => {
    const { app, a } = await boot(ON);
    const d = await draft(app, a);
    const res = await review(a, d.id, 'f'.repeat(64));
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('review_stale');
    expect((await rowOf(app, d.id))?.status).toBe('draft');
    expect(await auditEvents(app, a, 'submission.reviewed')).toEqual([]);
  });

  it('requires the acknowledgment, and refuses unknown keys or ids', async () => {
    const { app, a } = await boot(ON);
    const d = await draft(app, a);
    for (const body of [
      { reviewDigest: d.submission.reviewDigest },
      { reviewDigest: d.submission.reviewDigest, acknowledged: false },
      { reviewDigest: d.submission.reviewDigest, acknowledged: true, ids: [d.id] },
      { reviewDigest: 'not-a-digest', acknowledged: true },
    ]) {
      const res = await api(a, 'POST', `/submissions/${d.id}/review`, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
    }
    expect((await rowOf(app, d.id))?.status).toBe('draft');
  });

  it('a repeated review with the same digest answers the reviewed row, and writes nothing', async () => {
    const { app, a } = await boot(ON);
    const r = await reviewed(app, a);
    const again = await review(a, r.id, r.submission.reviewDigest);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toEqual(r.submission);
    expect(await auditEvents(app, a, 'submission.reviewed')).toHaveLength(1);
  });

  it('anything but a draft, or that replay, is 409 with its status', async () => {
    const { app, a } = await boot(ON);
    const r = await reviewed(app, a);
    expect((await handoff(a, r.id)).statusCode).toBe(200);
    const again = await review(a, r.id, r.submission.reviewDigest);
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().error.code).toBe('invalid_transition');
  });

  it('an edit after review returns the attempt to draft and clears the review', async () => {
    const { app, a } = await boot(ON);
    const r = await reviewed(app, a);
    const res = await api(a, 'PATCH', `/submissions/${r.id}`, {
      fields: { email: 'x@example.com' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const s = res.json() as SubmissionJson;
    expect(s.status).toBe('draft');
    expect(s.reviewExpiresAt).toBeNull();
    expect((await rowOf(app, r.id))?.reviewDigest).toBeNull();
  });
});

describe('AC1: handoff is refused, with nothing else changed', () => {
  async function refusedWithNothingChanged(
    app: FastifyInstance,
    c: TestClient,
    id: string,
    expectCode: string,
  ) {
    const rowBefore = await rowOf(app, id);
    const before = await counts(app, c);
    const res = await handoff(c, id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe(expectCode);
    expect(await counts(app, c)).toEqual(before);
    expect(await rowOf(app, id)).toEqual(rowBefore);
  }

  it('for a draft', async () => {
    const { app, a } = await boot(ON);
    const d = await draft(app, a);
    await refusedWithNothingChanged(app, a, d.id, 'invalid_transition');
  });

  it('for an expired review', async () => {
    const { app, a } = await boot(ON);
    const r = await reviewed(app, a);
    await app.db
      .update(applicationSubmissions)
      .set({ reviewExpiresAt: Date.now() - 1 })
      .where(eq(applicationSubmissions.id, r.id))
      .run();
    await refusedWithNothingChanged(app, a, r.id, 'review_expired');
  });

  it('for a review whose digest no longer matches the state (changed behind the review)', async () => {
    const { app, a } = await boot(ON);
    const r = await reviewed(app, a);
    // A change that bypasses PATCH (which would send it back to draft): the digest check at
    // handoff is the second guard.
    await app.db
      .update(applicationSubmissions)
      .set({ answers: [{ question: 'Why us?', answer: 'changed after review' }] })
      .where(eq(applicationSubmissions.id, r.id))
      .run();
    await refusedWithNothingChanged(app, a, r.id, 'review_stale');
  });

  it('for a review edited through the API (back to draft)', async () => {
    const { app, a } = await boot(ON);
    const r = await reviewed(app, a);
    await api(a, 'PATCH', `/submissions/${r.id}`, { fields: { email: 'other@example.com' } });
    await refusedWithNothingChanged(app, a, r.id, 'invalid_transition');
  });
});

describe('handoff', () => {
  it('returns the pinned destination and when the handoff lapses; audit only, no timeline', async () => {
    const { app, a } = await boot(ON);
    const r = await reviewed(app, a);
    const before = await counts(app, a);

    const res = await handoff(a, r.id);

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { destinationUrl: string; expiresAt: number };
    expect(body.destinationUrl).toBe(ATS_REF.url);
    const row = await rowOf(app, r.id);
    expect(row?.status).toBe('handed_off');
    expect(body.expiresAt).toBe((row?.handedOffAt as number) + HANDOFF_IDLE_MS);
    const after = await counts(app, a);
    expect(after.activities).toBe(before.activities);
    expect(after.stageHistory).toBe(before.stageHistory);
    expect(after.auditLog).toBe((before.auditLog ?? 0) + 1);
    const [event] = await auditEvents(app, a, 'submission.handed_off');
    expect(event?.detail).toMatchObject({ submissionId: r.id, host: 'boards.greenhouse.io' });
  });

  it('a repeated handoff answers the same destination, with no second audit entry', async () => {
    const { app, a } = await boot(ON);
    const r = await reviewed(app, a);
    const first = await handoff(a, r.id);
    const second = await handoff(a, r.id);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(await auditEvents(app, a, 'submission.handed_off')).toHaveLength(1);
  });
});

describe('AC2: the daily review cap', () => {
  /** `n` other submissions reviewed at `at`, for the same user (seeded through the table). */
  async function seedReviews(app: FastifyInstance, c: TestClient, n: number, at: number) {
    for (let i = 0; i < n; i += 1) {
      const d = await draft(app, c);
      await app.db
        .update(applicationSubmissions)
        .set({ status: 'abandoned', failureReason: 'cancelled_by_user', reviewedAt: at })
        .where(eq(applicationSubmissions.id, d.id))
        .run();
    }
  }

  it('the 11th review within a rolling 24 hours is refused with daily_review_cap and its reset time', async () => {
    const { app, a } = await boot(ON);
    const oldest = Date.now() - 60_000;
    await seedReviews(app, a, 10, oldest);
    const d = await draft(app, a);

    const res = await review(a, d.id, d.submission.reviewDigest);

    expect(res.statusCode, res.body).toBe(429);
    expect(res.json().error.code).toBe('daily_review_cap');
    expect(res.json().error.resetAt).toBe(oldest + 24 * 60 * 60 * 1000);
    expect((await rowOf(app, d.id))?.status).toBe('draft');
    expect(await auditEvents(app, a, 'submission.review_cap_hit')).toHaveLength(1);
  });

  it('at the boundary: a review 24h minus 1 ms ago still counts, 24h plus 1 ms ago does not', async () => {
    const now = Date.now();
    vi.useFakeTimers({ now, toFake: ['Date'] });
    try {
      const { app, a } = await boot(ON);
      const DAY = 24 * 60 * 60 * 1000;
      await seedReviews(app, a, 9, now - 60_000);
      await seedReviews(app, a, 1, now - DAY + 1);
      const inside = await draft(app, a);
      expect((await review(a, inside.id, inside.submission.reviewDigest)).statusCode).toBe(429);

      // The same ten, with the oldest now 1 ms past the window: room for one more.
      await app.db
        .update(applicationSubmissions)
        .set({ reviewedAt: now - DAY - 1 })
        .where(
          and(
            eq(applicationSubmissions.userId, a.userId),
            eq(applicationSubmissions.reviewedAt, now - DAY + 1),
          ),
        )
        .run();
      const outside = await review(a, inside.id, inside.submission.reviewDigest);
      expect(outside.statusCode, outside.body).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts per user: another user’s reviews do not use this user’s cap', async () => {
    const { app, a, b } = await boot(ON);
    await seedReviews(app, b, 10, Date.now() - 60_000);
    const d = await draft(app, a);
    expect((await review(a, d.id, d.submission.reviewDigest)).statusCode).toBe(200);
  });

  it('the user can set a lower cap than the instance’s', async () => {
    const { app, a } = await boot(ON);
    await writeUserSetting(app.db, ctxOf(a), DAILY_REVIEW_CAP_SETTING, 2);
    await seedReviews(app, a, 2, Date.now() - 60_000);
    const d = await draft(app, a);
    expect((await review(a, d.id, d.submission.reviewDigest)).statusCode).toBe(429);
  });

  it('a user value above the instance cap is not honoured: the instance cap stands', async () => {
    const { app, a } = await boot({ ...ON, dailyReviewCap: 2 });
    await writeUserSetting(app.db, ctxOf(a), DAILY_REVIEW_CAP_SETTING, 25);
    await seedReviews(app, a, 2, Date.now() - 60_000);
    const d = await draft(app, a);
    expect((await review(a, d.id, d.submission.reviewDigest)).statusCode).toBe(429);
  });

  it('the instance can set a lower cap', async () => {
    const { app, a } = await boot({ ...ON, dailyReviewCap: 2 });
    await seedReviews(app, a, 2, Date.now() - 60_000);
    const d = await draft(app, a);
    expect((await review(a, d.id, d.submission.reviewDigest)).statusCode).toBe(429);
  });
});

describe('AC3: a device token can do none of this', () => {
  it('cannot create, review or hand off', async () => {
    const { app, a } = await boot(ON);
    const r = await reviewed(app, a);
    const oppId = await seedOpportunity(app, a);
    const resumeId = await seedResume(app, a);
    const tokenRes = await a.request({
      method: 'POST',
      url: '/api/v1/device-tokens',
      payload: {
        name: 'Browser extension',
        scopes: ['capture:push'],
        password: 'correct horse battery',
      },
    });
    expect(tokenRes.statusCode, tokenRes.body).toBe(201);
    const bearer = { authorization: `Bearer ${(tokenRes.json() as { token: string }).token}` };
    const asDevice = (url: string, payload: object) =>
      app.inject({ method: 'POST', url: `/api/v1${url}`, headers: bearer, payload });

    const results = await Promise.all([
      asDevice(`/opportunities/${oppId}/submissions`, {
        idempotencyKey: crypto.randomUUID(),
        resumeId,
      }),
      asDevice(`/submissions/${r.id}/review`, {
        reviewDigest: r.submission.reviewDigest,
        acknowledged: true,
      }),
      asDevice(`/submissions/${r.id}/handoff`, {}),
    ]);
    for (const res of results) expect([401, 403], res.body).toContain(res.statusCode);
    expect((await rowOf(app, r.id))?.status).toBe('reviewed');
    expect(
      await app.db
        .select()
        .from(applicationSubmissions)
        .where(eq(applicationSubmissions.opportunityId, oppId))
        .all(),
    ).toEqual([]);
  });
});

describe('AC4: the whole M1 flow makes no outbound request', () => {
  it('create, edit, review, hand off, cancel and the expiry sweep fetch nothing', async () => {
    const { app, a } = await boot(ON);
    const fetched: string[] = [];
    app.jobs.services.sourceFetch = (async (url: string) => {
      fetched.push(`sourceFetch ${url}`);
      throw new Error('no fetch in this flow');
    }) as unknown as typeof safeFetch;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      fetched.push(`fetch ${String(input)}`);
      throw new Error('no fetch in this flow');
    }) as typeof fetch;
    try {
      const r = await reviewed(app, a);
      expect((await handoff(a, r.id)).statusCode).toBe(200);
      const other = await reviewed(app, a);
      await app.db
        .update(applicationSubmissions)
        .set({ reviewExpiresAt: Date.now() - 1 })
        .where(eq(applicationSubmissions.id, other.id))
        .run();
      await enqueue(app.db, SUBMISSION_EXPIRE_JOB_KIND, {});
      await runDueJobs(app.db, { services: app.jobs.services });
      expect((await rowOf(app, other.id))?.status).toBe('abandoned');
      const third = await draft(app, a);
      expect((await api(a, 'POST', `/submissions/${third.id}/cancel`)).statusCode).toBe(200);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetched).toEqual([]);
  });
});

describe('AC5: an answer value appears in no audit detail, job payload or log line', () => {
  it('the sentinel answer stays in the submission row only', async () => {
    const { app, a } = await boot(ON);
    const r = await reviewed(app, a);
    await handoff(a, r.id);
    const cap = await draft(app, a);
    await review(a, cap.id, 'f'.repeat(64));

    const audits = await app.db.select().from(auditLog).all();
    expect(JSON.stringify(audits)).not.toContain(SENTINEL);
    const jobRows = await app.db.select().from(jobs).all();
    expect(JSON.stringify(jobRows)).not.toContain(SENTINEL);
    expect(logs.text()).not.toContain(SENTINEL);
    // The value is there, where it belongs.
    expect(JSON.stringify((await rowOf(app, r.id))?.answers)).toContain(SENTINEL);
  });

  it('the audit redaction masks answers, fields, resume and text keys', async () => {
    const { redactDetail, REDACTED } = await import('../src/lib/audit');
    expect(
      redactDetail({
        answers: [SENTINEL],
        fields: { a: SENTINEL },
        resume: SENTINEL,
        text: SENTINEL,
        id: 'x',
      }),
    ).toEqual({ answers: REDACTED, fields: REDACTED, resume: REDACTED, text: REDACTED, id: 'x' });
  });
});

describe('AC6: the destination', () => {
  it.each([
    ['plain http', { ...ATS_REF, url: 'http://boards.greenhouse.io/examplecorp/jobs/1000001' }],
    ['LinkedIn', { ...ATS_REF, url: 'https://www.linkedin.com/jobs/view/1000001' }],
    ['lnkd.in', { ...ATS_REF, url: 'https://lnkd.in/abc1000001' }],
    ['Indeed', { ...ATS_REF, url: 'https://www.indeed.com/viewjob?jk=1000001' }],
    [
      'an unrelated host without the posting id',
      { ...ATS_REF, url: 'https://jobs.example.com/careers' },
    ],
    [
      'a lookalike ATS host',
      { ...ATS_REF, url: 'https://boards.greenhouse.io.example.com/x/jobs/1000001' },
    ],
  ])('refuses %s at handoff, and changes nothing', async (_name, ats) => {
    const { app, a } = await boot(ON);
    const r = await reviewed(app, a);
    // The destination was taken from the opportunity's ATS identity at create; here it is
    // replaced behind the API, so the handoff's own check is what is tested.
    await app.db
      .update(applicationSubmissions)
      .set({ destinationUrl: ats.url })
      .where(eq(applicationSubmissions.id, r.id))
      .run();
    const rowBefore = await rowOf(app, r.id);
    const res = await handoff(a, r.id);
    expect([409, 422], res.body).toContain(res.statusCode);
    expect((await rowOf(app, r.id))?.status).toBe(rowBefore?.status);
  });

  it.each([
    ['a recognised ATS posting URL', 'https://boards.greenhouse.io/examplecorp/jobs/1000001'],
    [
      'a career page carrying the posting id',
      'https://careers.example.com/open-roles?gh_jid=1000001',
    ],
  ])('accepts %s', async (_name, url) => {
    const { app, a } = await boot(ON);
    const r = await reviewed(app, a, { ...ATS_REF, url });
    const res = await handoff(a, r.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().destinationUrl).toBe(url);
  });
});

describe('the expiry sweeper', () => {
  it('abandons expired reviews and idle handoffs, and nothing else', async () => {
    const { app, a } = await boot(ON);
    const expired = await reviewed(app, a);
    const fresh = await reviewed(app, a);
    const idle = await reviewed(app, a);
    expect((await handoff(a, idle.id)).statusCode).toBe(200);
    const recent = await reviewed(app, a);
    expect((await handoff(a, recent.id)).statusCode).toBe(200);
    const now = Date.now();
    await app.db
      .update(applicationSubmissions)
      .set({ reviewExpiresAt: now - 1 })
      .where(eq(applicationSubmissions.id, expired.id))
      .run();
    await app.db
      .update(applicationSubmissions)
      .set({ handedOffAt: now - HANDOFF_IDLE_MS - 1 })
      .where(eq(applicationSubmissions.id, idle.id))
      .run();

    const { sweepSubmissions } = await import('../src/repos/submissionReview');
    await sweepSubmissions(app.db, now);

    expect(await rowOf(app, expired.id)).toMatchObject({
      status: 'abandoned',
      failureReason: 'review_expired',
    });
    expect((await rowOf(app, fresh.id))?.status).toBe('reviewed');
    expect((await rowOf(app, idle.id))?.status).toBe('abandoned');
    expect((await rowOf(app, recent.id))?.status).toBe('handed_off');
    expect(await auditEvents(app, a, 'submission.abandoned')).toHaveLength(2);
  });
});

describe('another user’s submission', () => {
  it('cannot be reviewed or handed off: 404', async () => {
    const { app, a, b } = await boot(ON);
    const r = await reviewed(app, a);
    const d = await draft(app, a);
    expect((await review(b, d.id, d.submission.reviewDigest)).statusCode).toBe(404);
    expect((await handoff(b, r.id)).statusCode).toBe(404);
    expect((await rowOf(app, d.id))?.status).toBe('draft');
    expect((await rowOf(app, r.id))?.status).toBe('reviewed');
  });
});

describe('concurrency', () => {
  it('two reviews of one draft: one transition, one audit entry, both get the reviewed row', async () => {
    const { app, a } = await boot(ON);
    const d = await draft(app, a);
    // Both callers past their checks, neither past its write: the conditional update decides.
    const barrier = holdAt('submissions.review', 2);
    const [one, two] = await Promise.all([
      review(a, d.id, d.submission.reviewDigest),
      review(a, d.id, d.submission.reviewDigest),
    ]);
    setRaceHook(undefined);
    expect(barrier.arrived()).toBe(2);
    expect([one.statusCode, two.statusCode]).toEqual([200, 200]);
    expect(one.json()).toEqual(two.json());
    expect((await rowOf(app, d.id))?.status).toBe('reviewed');
    expect(await auditEvents(app, a, 'submission.reviewed')).toHaveLength(1);
  });

  it('two reviews of different drafts for the last place under the cap: one passes', async () => {
    // The count and the write happen under the user's scope lock, so on Postgres two open
    // transactions cannot both count the same nine (qa's Postgres-only race on #124).
    const { app, a } = await boot({ ...ON, dailyReviewCap: 1 });
    const one = await draft(app, a);
    const two = await draft(app, a);
    const barrier = holdAt('submissions.review', 2);
    const results = await Promise.all([
      review(a, one.id, one.submission.reviewDigest),
      review(a, two.id, two.submission.reviewDigest),
    ]);
    setRaceHook(undefined);
    expect(barrier.arrived()).toBe(2);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 429]);
    expect(await auditEvents(app, a, 'submission.reviewed')).toHaveLength(1);
  });

  it('two handoffs of one review: one transition, one audit entry, both get the destination', async () => {
    const { app, a } = await boot(ON);
    const r = await reviewed(app, a);
    const barrier = holdAt('submissions.handoff', 2);
    const [one, two] = await Promise.all([handoff(a, r.id), handoff(a, r.id)]);
    setRaceHook(undefined);
    expect(barrier.arrived()).toBe(2);
    expect([one.statusCode, two.statusCode]).toEqual([200, 200]);
    expect(one.json()).toEqual(two.json());
    expect((await rowOf(app, r.id))?.status).toBe('handed_off');
    expect(await auditEvents(app, a, 'submission.handed_off')).toHaveLength(1);
  });
});
