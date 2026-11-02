// After the handoff (assisted apply M2a, https://github.com/bgoleno/opportun/issues/118): "I
// submitted it", the user's outcome reports, the follow-up when no confirmation is seen, and the
// re-apply guard. Organised by the issue's acceptance criteria. Every opportunity, resume and
// posting is synthetic; nothing here, or in the code under test, contacts an employer or an ATS.
import { newId, type AtsJobRef } from '@opportun/core';
import { and, count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  activities,
  applicationSubmissions,
  auditLog,
  jobs,
  nextSteps,
  opportunities,
  resumes,
  stageHistory,
} from '../src/db/schema';
import { readSchedules } from '../src/jobs/runner';
import { SUBMISSION_FOLLOWUP_JOB_KIND } from '../src/jobs/submissionFollowup';
import type { safeFetch } from '../src/lib/safeFetch';
import type { UserCtx } from '../src/repos/base';
import { createOpportunity } from '../src/repos/opportunities';
import { insertResume } from '../src/repos/resumes';
import { FOLLOWUP_MS, followUpSubmissions } from '../src/repos/submissionOutcome';
import { useApi } from './api';
import type { TestClient } from './isolation';
import { holdAt } from './race';

const boot = useApi();
const ON = { submissions: true };
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });

const ATS_REF: AtsJobRef = {
  kind: 'ats_greenhouse',
  org: 'examplecorp',
  externalId: '1000001',
  url: 'https://boards.greenhouse.io/examplecorp/jobs/1000001',
};
/** A field value that must never reach the timeline: only field names do. */
const FIELD_VALUE = 'jane.field-value@example.com';
const ANSWER_VALUE = 'ANSWER-value-4b1d';

const api = (
  c: TestClient,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: Record<string, unknown>,
) => c.request({ method, url: `/api/v1${url}`, ...(payload === undefined ? {} : { payload }) });

/** A requisition of its own, so one test's application is not another attempt's re-apply. */
function freshRef(): AtsJobRef {
  const externalId = String(Math.floor(1_000_000 + Math.random() * 8_999_999));
  return {
    ...ATS_REF,
    externalId,
    url: `https://boards.greenhouse.io/examplecorp/jobs/${externalId}`,
  };
}

async function seedOpportunity(
  app: FastifyInstance,
  c: TestClient,
  stage = 'interested',
  ats: AtsJobRef = freshRef(),
) {
  const opp = await createOpportunity(app.db, ctxOf(c), {
    companyName: 'Example Corp',
    title: `Senior Example Engineer ${newId().slice(-6)}`,
    sourceKind: 'manual',
  });
  await app.db
    .update(opportunities)
    .set({
      stage: stage as 'interested',
      atsJobRef: ats,
      postingState: 'confirmed',
    })
    .where(eq(opportunities.id, opp.id))
    .run();
  return opp;
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
  reapplyOf: string | null;
  reapplyReason: string | null;
  submittedActivityId: string | null;
  submittedAt: number | null;
}

/** A draft for a fresh eligible opportunity, its snapshot settled, with a field and an answer. */
async function draftFor(
  app: FastifyInstance,
  c: TestClient,
  stage = 'interested',
  ats: AtsJobRef = freshRef(),
) {
  const opp = await seedOpportunity(app, c, stage, ats);
  const resumeId = await seedResume(app, c);
  const created = await api(c, 'POST', `/opportunities/${opp.id}/submissions`, {
    idempotencyKey: crypto.randomUUID(),
    resumeId,
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json<SubmissionJson>().id;
  await app.jobs.drain(); // the local file's snapshot: unsupported, which review allows
  const edited = await api(c, 'PATCH', `/submissions/${id}`, {
    fields: { email: FIELD_VALUE },
    answers: [{ questionKey: 'why_us', label: 'Why us?', value: ANSWER_VALUE, source: 'user' }],
  });
  expect(edited.statusCode, edited.body).toBe(200);
  return {
    oppId: opp.id,
    opp,
    ats,
    resumeId,
    id,
    digest: edited.json<SubmissionJson>().reviewDigest,
  };
}

const review = (c: TestClient, id: string, reviewDigest: string, extra = {}) =>
  api(c, 'POST', `/submissions/${id}/review`, { reviewDigest, acknowledged: true, ...extra });

/** A draft taken through review and handoff: ready for "I submitted it". */
async function handedOff(
  app: FastifyInstance,
  c: TestClient,
  stage = 'interested',
  ats: AtsJobRef = freshRef(),
) {
  const d = await draftFor(app, c, stage, ats);
  const r = await review(c, d.id, d.digest);
  expect(r.statusCode, r.body).toBe(200);
  const h = await api(c, 'POST', `/submissions/${d.id}/handoff`, {});
  expect(h.statusCode, h.body).toBe(200);
  return d;
}

const attest = (
  c: TestClient,
  id: string,
  body: Record<string, unknown> = { moveToApplied: true },
) => api(c, 'POST', `/submissions/${id}/attest`, body);

const outcome = (c: TestClient, id: string, body: Record<string, unknown>) =>
  api(c, 'POST', `/submissions/${id}/outcome`, body);

async function rowOf(app: FastifyInstance, id: string) {
  return await app.db
    .select()
    .from(applicationSubmissions)
    .where(eq(applicationSubmissions.id, id))
    .get();
}

async function countsFor(app: FastifyInstance, oppId: string) {
  const n = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
  return {
    applications: await n(
      app.db
        .select({ n: count() })
        .from(activities)
        .where(and(eq(activities.opportunityId, oppId), eq(activities.kind, 'application'))),
    ),
    notes: await n(
      app.db
        .select({ n: count() })
        .from(activities)
        .where(and(eq(activities.opportunityId, oppId), eq(activities.kind, 'note'))),
    ),
    stageChanges: await n(
      app.db.select({ n: count() }).from(stageHistory).where(eq(stageHistory.opportunityId, oppId)),
    ),
    nextSteps: await n(
      app.db.select({ n: count() }).from(nextSteps).where(eq(nextSteps.opportunityId, oppId)),
    ),
  };
}

const stageOf = async (app: FastifyInstance, oppId: string) =>
  (
    await app.db
      .select({ stage: opportunities.stage })
      .from(opportunities)
      .where(eq(opportunities.id, oppId))
      .get()
  )?.stage;

describe('criterion 1: "I submitted it" records one timeline entry and one resume update', () => {
  it('records the application, the resume and the attempt, with field names and no values', async () => {
    const { app, a } = await boot(ON);
    const d = await handedOff(app, a);
    const before = await countsFor(app, d.oppId);

    const res = await attest(a, d.id, { moveToApplied: false });
    expect(res.statusCode, res.body).toBe(200);
    const sub = res.json<SubmissionJson>();
    expect(sub.status).toBe('submitted');

    const after = await countsFor(app, d.oppId);
    expect(after.applications - before.applications).toBe(1);
    const entry = await app.db
      .select()
      .from(activities)
      .where(eq(activities.id, sub.submittedActivityId as string))
      .get();
    expect(entry).toMatchObject({
      kind: 'application',
      title: `Applied via Greenhouse: ${d.opp.title}`,
      externalUrl: d.ats.url,
    });
    expect(entry?.bodyMd).toContain('Resume: Example Resume, attached by you (no saved copy).');
    expect(entry?.bodyMd).toContain('Filled in: email.');
    expect(entry?.bodyMd).toContain('Answered: "Why us?".');
    expect(entry?.bodyMd).toContain('Basis: you reported submitting this.');
    // Names only: the values the user filled in stay on the attempt.
    expect(entry?.bodyMd).not.toContain(FIELD_VALUE);
    expect(entry?.bodyMd).not.toContain(ANSWER_VALUE);

    const resume = await app.db.select().from(resumes).where(eq(resumes.id, d.resumeId)).get();
    expect(resume).toMatchObject({ status: 'submitted', submittedTo: 'Greenhouse / Example Corp' });
    expect(await rowOf(app, d.id)).toMatchObject({
      submittedBasis: 'user_attested',
      submittedActivityId: sub.submittedActivityId,
    });
  });

  it('moves the stage to Applied only while "Move to Applied" stays ticked', async () => {
    const { app, a } = await boot(ON);
    const ticked = await handedOff(app, a);
    expect((await attest(a, ticked.id, { moveToApplied: true })).statusCode).toBe(200);
    expect(await stageOf(app, ticked.oppId)).toBe('applied');
    const history = await app.db
      .select()
      .from(stageHistory)
      .where(eq(stageHistory.opportunityId, ticked.oppId))
      .all();
    expect(history.map((h) => h.note)).toContain('Applied via assisted submission');

    const unticked = await handedOff(app, a);
    const before = await countsFor(app, unticked.oppId);
    expect((await attest(a, unticked.id, { moveToApplied: false })).statusCode).toBe(200);
    expect(await stageOf(app, unticked.oppId)).toBe('interested');
    expect((await countsFor(app, unticked.oppId)).stageChanges).toBe(before.stageChanges);
  });

  it('never moves a stage already past Applied back to it', async () => {
    const { app, a } = await boot(ON);
    const d = await handedOff(app, a);
    await app.db
      .update(opportunities)
      .set({ stage: 'in_process' })
      .where(eq(opportunities.id, d.oppId))
      .run();
    expect((await attest(a, d.id, { moveToApplied: true })).statusCode).toBe(200);
    expect(await stageOf(app, d.oppId)).toBe('in_process');
  });

  it('two concurrent attests record exactly one application, one stage change and one resume update (race)', async () => {
    const { app, a } = await boot(ON);
    const d = await handedOff(app, a);
    const before = await countsFor(app, d.oppId);
    // Two different times, so a second write to the resume would show (tl on #145).
    const handedOffAt = (await rowOf(app, d.id))?.handedOffAt as number;
    const barrier = holdAt('submissions.attest', 2);
    const [one, two] = await Promise.all([
      attest(a, d.id, { moveToApplied: true, submittedAt: handedOffAt }),
      attest(a, d.id, { moveToApplied: true, submittedAt: handedOffAt + 1 }),
    ]);
    expect(barrier.arrived()).toBe(2);
    expect([one.statusCode, two.statusCode]).toEqual([200, 200]);
    expect(one.json<SubmissionJson>().submittedActivityId).toBe(
      two.json<SubmissionJson>().submittedActivityId,
    );
    const after = await countsFor(app, d.oppId);
    expect(after.applications - before.applications).toBe(1);
    expect(after.stageChanges - before.stageChanges).toBe(1);
    const attested = await app.db
      .select({ n: count() })
      .from(auditLog)
      .where(eq(auditLog.event, 'submission.attested'))
      .get();
    expect(attested?.n).toBe(1);
    // One resume update: it carries the winner's time, the same the attempt and its entry carry.
    const row = await rowOf(app, d.id);
    const resume = await app.db.select().from(resumes).where(eq(resumes.id, d.resumeId)).get();
    const entry = await app.db
      .select()
      .from(activities)
      .where(eq(activities.id, row?.submittedActivityId as string))
      .get();
    expect(resume?.submittedAt).toBe(row?.submittedAt);
    expect(entry?.occurredAt).toBe(row?.submittedAt);
  });

  it('a stage moved by the attest gets the usual follow-on (afterStageChange): the company homepage is looked up', async () => {
    const { app, a } = await boot(ON);
    const domainJobs = async () =>
      (await app.db.select().from(jobs).where(eq(jobs.kind, 'company.domain_resolve')).all())
        .length;
    const unticked = await handedOff(app, a);
    const before = await domainJobs();
    await attest(a, unticked.id, { moveToApplied: false });
    expect(await domainJobs()).toBe(before);
    const ticked = await handedOff(app, a);
    await app.db.delete(jobs).where(eq(jobs.kind, 'company.domain_resolve')).run();
    await attest(a, ticked.id, { moveToApplied: true });
    expect(await stageOf(app, ticked.oppId)).toBe('applied');
    expect(await domainJobs()).toBe(1);
  });

  it('a repeat answers the same attempt and creates nothing', async () => {
    const { app, a } = await boot(ON);
    const d = await handedOff(app, a);
    const first = await attest(a, d.id);
    const mid = await countsFor(app, d.oppId);
    const again = await attest(a, d.id);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(await countsFor(app, d.oppId)).toEqual(mid);
  });

  it('a resume already submitted elsewhere keeps its record', async () => {
    const { app, a } = await boot(ON);
    const d = await handedOff(app, a);
    await app.db
      .update(resumes)
      .set({ status: 'submitted', submittedTo: 'Elsewhere', submittedAt: 1 })
      .where(eq(resumes.id, d.resumeId))
      .run();
    expect((await attest(a, d.id)).statusCode).toBe(200);
    const resume = await app.db.select().from(resumes).where(eq(resumes.id, d.resumeId)).get();
    expect(resume).toMatchObject({ submittedTo: 'Elsewhere', submittedAt: 1 });
  });

  it('takes the time the user gives, and refuses one in the future or before the handoff', async () => {
    const { app, a } = await boot(ON);
    const d = await handedOff(app, a);
    const future = await attest(a, d.id, {
      moveToApplied: false,
      submittedAt: Date.now() + 3_600_000,
    });
    expect(future.statusCode).toBe(422);
    expect(future.json()).toMatchObject({ error: { code: 'submitted_at_in_future' } });
    expect((await rowOf(app, d.id))?.status).toBe('handed_off');

    // Before the form was opened (beyond the clock skew) is refused too (tl on #145).
    const handedOffAt = (await rowOf(app, d.id))?.handedOffAt as number;
    const early = await attest(a, d.id, {
      moveToApplied: false,
      submittedAt: handedOffAt - 61_000,
    });
    expect(early.statusCode).toBe(422);
    expect(early.json()).toMatchObject({ error: { code: 'submitted_at_before_handoff' } });
    expect((await rowOf(app, d.id))?.status).toBe('handed_off');

    // Within the skew of the handoff is accepted, as the user gave it.
    const at = handedOffAt - 30_000;
    const res = await attest(a, d.id, { moveToApplied: false, submittedAt: at });
    expect(res.json()).toMatchObject({ submittedAt: at });
    const entry = await app.db
      .select()
      .from(activities)
      .where(eq(activities.id, res.json<SubmissionJson>().submittedActivityId as string))
      .get();
    expect(entry?.occurredAt).toBe(at);
  });

  it('is refused before the handoff, and for a body without the tick or with other keys', async () => {
    const { app, a } = await boot(ON);
    const d = await draftFor(app, a);
    const early = await attest(a, d.id);
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ error: { code: 'invalid_transition' } });
    const h = await handedOff(app, a);
    expect((await attest(a, h.id, {})).statusCode).toBe(422);
    expect(
      (await attest(a, h.id, { moveToApplied: true, opportunityId: h.oppId })).statusCode,
    ).toBe(422);
    expect((await rowOf(app, h.id))?.status).toBe('handed_off');
  });

  it("another user's attempt reads as missing", async () => {
    const { app, a, b } = await boot(ON);
    const d = await handedOff(app, a);
    expect((await attest(b, d.id)).statusCode).toBe(404);
    expect((await outcome(b, d.id, { outcome: 'failed' })).statusCode).toBe(404);
    expect((await rowOf(app, d.id))?.status).toBe('handed_off');
  });
});

describe('criterion 2: no confirmation after 3 days shows a next step; nothing is retried or sent', () => {
  it('marks an attempt unknown at 3 days, with one next step, and not a millisecond before', async () => {
    const { app, a } = await boot(ON);
    const d = await handedOff(app, a);
    const submittedAt = Date.now() - 1000;
    expect((await attest(a, d.id, { moveToApplied: false, submittedAt })).statusCode).toBe(200);

    expect(await followUpSubmissions(app.db, submittedAt + FOLLOWUP_MS - 1)).toBe(0);
    expect((await rowOf(app, d.id))?.status).toBe('submitted');
    expect(await followUpSubmissions(app.db, submittedAt + FOLLOWUP_MS)).toBe(1);
    expect((await rowOf(app, d.id))?.status).toBe('unknown');
    const steps = await app.db
      .select()
      .from(nextSteps)
      .where(eq(nextSteps.opportunityId, d.oppId))
      .all();
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      action: 'Check whether your application to Example Corp was received',
      owner: 'you',
      doneAt: null,
    });
    // A second run finds nothing: one next step, ever.
    expect(await followUpSubmissions(app.db, submittedAt + 2 * FOLLOWUP_MS)).toBe(0);
    expect((await countsFor(app, d.oppId)).nextSteps).toBe(1);
  });

  it('links the attempt to the next step it created; deleting the step clears the link', async () => {
    const { app, a } = await boot(ON);
    const d = await handedOff(app, a);
    const submittedAt = (await rowOf(app, d.id))?.handedOffAt as number;
    await attest(a, d.id, { moveToApplied: false, submittedAt });
    expect((await rowOf(app, d.id))?.followupNextStepId).toBeNull();
    await followUpSubmissions(app.db, submittedAt + FOLLOWUP_MS);
    const step = await app.db
      .select()
      .from(nextSteps)
      .where(eq(nextSteps.opportunityId, d.oppId))
      .get();
    expect(step).toBeDefined();
    expect((await rowOf(app, d.id))?.followupNextStepId).toBe(step?.id);
    // ON DELETE SET NULL (both engines' migrations): the user's own delete just clears it.
    await app.db
      .delete(nextSteps)
      .where(eq(nextSteps.id, step?.id as string))
      .run();
    expect(await rowOf(app, d.id)).toMatchObject({ status: 'unknown', followupNextStepId: null });
  });

  it('leaves a confirmed or reported attempt alone', async () => {
    const { app, a } = await boot(ON);
    const d = await handedOff(app, a);
    const submittedAt = Date.now() - 1000;
    await attest(a, d.id, { moveToApplied: false, submittedAt });
    expect((await outcome(a, d.id, { outcome: 'confirmed_by_user' })).statusCode).toBe(200);
    expect(await followUpSubmissions(app.db, submittedAt + FOLLOWUP_MS)).toBe(0);
    expect((await rowOf(app, d.id))?.status).toBe('confirmed');
  });

  it('attest, outcomes and the follow-up make no outbound request and queue no job', async () => {
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
      const d = await handedOff(app, a, 'applied'); // no stage move, so no company job either
      const jobsBefore = (await app.db.select({ n: count() }).from(jobs).get())?.n;
      const submittedAt = Date.now() - 1000;
      await attest(a, d.id, { moveToApplied: true, submittedAt });
      await followUpSubmissions(app.db, submittedAt + FOLLOWUP_MS);
      await outcome(a, d.id, { outcome: 'ats_refused', note: 'It said the form had errors.' });
      expect((await app.db.select({ n: count() }).from(jobs).get())?.n).toBe(jobsBefore);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetched).toEqual([]);
  });

  it('the follow-up is scheduled only while the feature is on', async () => {
    const kinds = async (app: FastifyInstance) => (await readSchedules(app.db)).map((r) => r.kind);
    expect(await kinds((await boot(ON)).app)).toContain(SUBMISSION_FOLLOWUP_JOB_KIND);
    expect(await kinds((await boot({ submissions: false })).app)).not.toContain(
      SUBMISSION_FOLLOWUP_JOB_KIND,
    );
  });
});

describe("the user's outcome reports", () => {
  it('"I saw a confirmation" after no confirmation was seen: confirmed by the user, with a note', async () => {
    const { app, a } = await boot(ON);
    const d = await handedOff(app, a);
    const submittedAt = Date.now() - 1000;
    await attest(a, d.id, { moveToApplied: false, submittedAt });
    await followUpSubmissions(app.db, submittedAt + FOLLOWUP_MS);
    const before = await countsFor(app, d.oppId);
    const res = await outcome(a, d.id, { outcome: 'confirmed_by_user' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'confirmed', confirmationKind: 'user' });
    expect((await countsFor(app, d.oppId)).notes - before.notes).toBe(1);
    // A repeat answers it unchanged.
    expect((await outcome(a, d.id, { outcome: 'confirmed_by_user' })).json()).toEqual(res.json());
    expect((await countsFor(app, d.oppId)).notes - before.notes).toBe(1);
  });

  it('"the site refused it": rejected, a note with the user\'s words, and the stage left alone', async () => {
    const { app, a } = await boot(ON);
    const d = await handedOff(app, a);
    await attest(a, d.id, { moveToApplied: true });
    expect(await stageOf(app, d.oppId)).toBe('applied');
    const res = await outcome(a, d.id, {
      outcome: 'ats_refused',
      note: 'It said already applied.',
    });
    expect(res.json()).toMatchObject({ status: 'rejected' });
    const note = await app.db
      .select()
      .from(activities)
      .where(and(eq(activities.opportunityId, d.oppId), eq(activities.kind, 'note')))
      .get();
    expect(note).toMatchObject({ title: 'The application site refused the form' });
    expect(note?.bodyMd).toContain('It said already applied.');
    expect(note?.bodyMd).toContain('Your stage was not changed.');
    expect(await stageOf(app, d.oppId)).toBe('applied');
  });

  it('a problem before submitting: failed, with nothing on the timeline', async () => {
    const { app, a } = await boot(ON);
    const d = await handedOff(app, a);
    const before = await countsFor(app, d.oppId);
    const res = await outcome(a, d.id, { outcome: 'failed', note: 'The form would not load.' });
    expect(res.json()).toMatchObject({ status: 'failed', failureReason: 'other' });
    expect(await countsFor(app, d.oppId)).toEqual(before);
  });

  it('refuses an outcome the status cannot take, changing nothing', async () => {
    const { app, a } = await boot(ON);
    const d = await handedOff(app, a);
    const early = await outcome(a, d.id, { outcome: 'confirmed_by_user' });
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ error: { code: 'invalid_transition' } });
    expect((await outcome(a, d.id, { outcome: 'shipped' })).statusCode).toBe(422);
    expect((await rowOf(app, d.id))?.status).toBe('handed_off');
  });
});

describe('criterion 3: applying again to the same requisition needs a typed reason', () => {
  /** A first application, attested, then a second attempt at the same posting ready to review. */
  async function secondAttempt(app: FastifyInstance, c: TestClient) {
    const first = await handedOff(app, c);
    expect((await attest(c, first.id, { moveToApplied: false })).statusCode).toBe(200);
    const second = await draftFor(app, c, 'interested', first.ats);
    return { first, second };
  }

  it('is refused at review without a reason, with nothing changed', async () => {
    const { app, a } = await boot(ON);
    const { first, second } = await secondAttempt(app, a);
    const res = await review(a, second.id, second.digest);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      error: { code: 'reapply_reason_required', submissionId: first.id },
    });
    expect(await rowOf(app, second.id)).toMatchObject({
      status: 'draft',
      reviewedAt: null,
      reapplyReason: null,
    });
    // Whitespace is not a reason.
    expect((await review(a, second.id, second.digest, { reapplyReason: '   ' })).statusCode).toBe(
      422,
    );
  });

  it('goes ahead with a reason, kept with the attempt and named on its timeline entry', async () => {
    const { app, a } = await boot(ON);
    const { first, second } = await secondAttempt(app, a);
    const reason = 'The recruiter asked me to apply again with the new resume.';
    const res = await review(a, second.id, second.digest, { reapplyReason: reason });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ reapplyOf: first.id, reapplyReason: reason });
    expect((await api(a, 'POST', `/submissions/${second.id}/handoff`, {})).statusCode).toBe(200);
    const attested = await attest(a, second.id, { moveToApplied: false });
    const entry = await app.db
      .select()
      .from(activities)
      .where(eq(activities.id, attested.json<SubmissionJson>().submittedActivityId as string))
      .get();
    expect(entry?.bodyMd).toContain(`Applied again: ${reason}`);
  });

  it('a first application needs no reason, and a form the ATS refused does not count', async () => {
    const { app, a } = await boot(ON);
    const first = await handedOff(app, a);
    expect(first).toBeDefined(); // reviewed without a reason: the first application
    await attest(a, first.id, { moveToApplied: false });
    await outcome(a, first.id, { outcome: 'ats_refused' });
    const again = await draftFor(app, a, 'interested', first.ats);
    const res = await review(a, again.id, again.digest);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ reapplyOf: null, reapplyReason: null });
  });

  it.each([
    [
      'reviewed',
      async (app: FastifyInstance, c: TestClient, ats: AtsJobRef) => {
        const d = await draftFor(app, c, 'interested', ats);
        expect((await review(c, d.id, d.digest)).statusCode).toBe(200);
      },
    ],
    [
      'opened on the ATS (handed off)',
      async (app: FastifyInstance, c: TestClient, ats: AtsJobRef) => {
        await handedOff(app, c, 'interested', ats);
      },
    ],
    [
      'with no confirmation seen (unknown)',
      async (app: FastifyInstance, c: TestClient, ats: AtsJobRef) => {
        const d = await handedOff(app, c, 'interested', ats);
        const at = (await rowOf(app, d.id))?.handedOffAt as number;
        await attest(c, d.id, { moveToApplied: false, submittedAt: at });
        expect(await followUpSubmissions(app.db, at + FOLLOWUP_MS)).toBe(1);
      },
    ],
    [
      'confirmed',
      async (app: FastifyInstance, c: TestClient, ats: AtsJobRef) => {
        const d = await handedOff(app, c, 'interested', ats);
        await attest(c, d.id, { moveToApplied: false });
        expect((await outcome(c, d.id, { outcome: 'confirmed_by_user' })).statusCode).toBe(200);
      },
    ],
  ] as const)(
    'an attempt at the same requisition on another opportunity that is %s needs a reason too (tl on #145)',
    async (_n, earlier) => {
      const { app, a } = await boot(ON);
      const ats = freshRef();
      await earlier(app, a, ats);
      const again = await draftFor(app, a, 'interested', ats);
      const res = await review(a, again.id, again.digest);
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json()).toMatchObject({ error: { code: 'reapply_reason_required' } });
    },
  );

  it('a draft elsewhere is not yet an application: no reason needed', async () => {
    const { app, a } = await boot(ON);
    const ats = freshRef();
    await draftFor(app, a, 'interested', ats);
    const again = await draftFor(app, a, 'interested', ats);
    expect((await review(a, again.id, again.digest)).statusCode).toBe(200);
  });

  it('the board name compares without case (a Workday site keeps its tenant case)', async () => {
    const { app, a } = await boot(ON);
    const ats = freshRef();
    await handedOff(app, a, 'interested', { ...ats, org: 'ExampleCorp' });
    const again = await draftFor(app, a, 'interested', { ...ats, org: 'examplecorp' });
    const res = await review(a, again.id, again.digest);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'reapply_reason_required' } });
  });

  it('a reason typed for a first application is not kept', async () => {
    const { app, a } = await boot(ON);
    const d = await draftFor(app, a);
    const res = await review(a, d.id, d.digest, { reapplyReason: 'just because' });
    expect(res.json()).toMatchObject({ reapplyOf: null, reapplyReason: null });
  });
});

describe('criterion 4: behind the flag', () => {
  it('attest and outcome answer feature_unavailable while it is off', async () => {
    const { a } = await boot({ submissions: false });
    for (const res of [
      await attest(a, newId()),
      await outcome(a, newId(), { outcome: 'failed' }),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: 'feature_unavailable' } });
    }
  });
});
