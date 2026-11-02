// A posting change under a live attempt (https://github.com/bgoleno/opportun/issues/144, the
// owner's option A): the attempt keeps its pinned destination and the user's work, a review
// goes back to draft, and a review screen shown before the change cannot be confirmed.
// Organised by the issue's acceptance criteria. Every URL is synthetic; nothing is fetched.
import { newId, type AtsJobRef, type NormalizedPosting } from '@opportun/core';
import { and, count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { applicationSubmissions, auditLog, opportunities, resumes } from '../src/db/schema';
import { confirm } from '../src/jobs/postingReconcile';
import type { UserCtx } from '../src/repos/base';
import { createOpportunity, getOpportunity, setPostingState } from '../src/repos/opportunities';
import { backfillAtsJobRefs } from '../src/jobs/atsJobRefBackfill';
import { insertResume } from '../src/repos/resumes';
import { useApi } from './api';
import type { TestClient } from './isolation';
import { pauseAt } from './race';

const boot = useApi();
const ON = { submissions: true };
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });

const OLD_URL = 'https://boards.greenhouse.io/examplecorp/jobs/1000001';
const NEW_URL = 'https://boards.greenhouse.io/examplecorp/jobs/2000002';
const CAREER_PAGE_URL = 'https://www.examplecorp.example/careers/apply?gh_jid=2000002';
const OLD_REF: AtsJobRef = {
  kind: 'ats_greenhouse',
  org: 'examplecorp',
  externalId: '1000001',
  url: OLD_URL,
};

const api = (
  c: TestClient,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: Record<string, unknown>,
) => c.request({ method, url: `/api/v1${url}`, ...(payload === undefined ? {} : { payload }) });

interface SubmissionJson {
  id: string;
  status: string;
  reviewDigest: string;
  destinationUrl: string;
  postingChangedAt: number | null;
}

/** A draft for a fresh eligible opportunity at OLD_URL, its snapshot settled, with work in it. */
async function draft(app: FastifyInstance, c: TestClient, start: AtsJobRef = OLD_REF) {
  const opp = await createOpportunity(app.db, ctxOf(c), {
    companyName: 'Example Corp',
    title: `Senior Example Engineer ${newId().slice(-6)}`,
    sourceKind: 'manual',
  });
  await app.db
    .update(opportunities)
    .set({
      stage: 'interested',
      atsJobRef: start,
      postingUrl: start.url,
      postingState: 'confirmed',
    })
    .where(eq(opportunities.id, opp.id))
    .run();
  const r = await insertResume(app.db, ctxOf(c), {
    kind: 'base',
    title: 'Example Resume',
    store: 'local_file',
    docRef: `resumes/${newId()}.txt`,
    opportunityId: null,
    parentResumeId: null,
  });
  await app.db.update(resumes).set({ status: 'final' }).where(eq(resumes.id, r.id)).run();
  const created = await api(c, 'POST', `/opportunities/${opp.id}/submissions`, {
    idempotencyKey: crypto.randomUUID(),
    resumeId: r.id,
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json<SubmissionJson>().id;
  await app.jobs.drain(); // the local file's snapshot settles as unsupported, which review allows
  const edited = await api(c, 'PATCH', `/submissions/${id}`, {
    fields: { email: 'jane@example.com' },
    answers: [{ questionKey: 'why', label: 'Why us?', value: 'Latex.', source: 'user' }],
  });
  expect(edited.statusCode, edited.body).toBe(200);
  return { oppId: opp.id, resumeId: r.id, id, digest: edited.json<SubmissionJson>().reviewDigest };
}

const review = (c: TestClient, id: string, reviewDigest: string) =>
  api(c, 'POST', `/submissions/${id}/review`, { reviewDigest, acknowledged: true });
const handoff = (c: TestClient, id: string) => api(c, 'POST', `/submissions/${id}/handoff`, {});
const changePosting = (c: TestClient, oppId: string, postingUrl: string) =>
  api(c, 'PATCH', `/opportunities/${oppId}`, { postingUrl });

async function reviewed(app: FastifyInstance, c: TestClient, start: AtsJobRef = OLD_REF) {
  const d = await draft(app, c, start);
  const r = await review(c, d.id, d.digest);
  expect(r.statusCode, r.body).toBe(200);
  return d;
}

async function rowOf(app: FastifyInstance, id: string) {
  return await app.db
    .select()
    .from(applicationSubmissions)
    .where(eq(applicationSubmissions.id, id))
    .get();
}

const posting = (postingUrl: string): NormalizedPosting =>
  ({
    company: 'Example Corp',
    title: 'Senior Example Engineer',
    descriptionMd: 'The new posting.',
    postingUrl,
  }) as NormalizedPosting;

describe('criterion 1: a posting change sends a review back to draft; a draft stays a draft', () => {
  it('reviewed: back to draft, the change recorded, the destination and the work kept', async () => {
    const { app, a } = await boot(ON);
    const d = await reviewed(app, a);
    expect((await changePosting(a, d.oppId, NEW_URL)).statusCode).toBe(200);
    const row = await rowOf(app, d.id);
    expect(row).toMatchObject({
      status: 'draft',
      reviewDigest: null,
      reviewExpiresAt: null,
      destinationUrl: OLD_URL, // pinned: the attempt still goes where it started
      atsExternalId: '1000001',
      fields: { email: 'jane@example.com' },
      failureReason: null,
    });
    expect(row?.answers).toHaveLength(1);
    expect(row?.postingChangedAt).not.toBeNull();
    const audits = await app.db
      .select({ n: count() })
      .from(auditLog)
      .where(eq(auditLog.event, 'submission.posting_changed'))
      .get();
    expect(audits?.n).toBe(1);
  });

  it('draft: stays a draft, with the change recorded and a new digest to review against', async () => {
    const { app, a } = await boot(ON);
    const d = await draft(app, a);
    await changePosting(a, d.oppId, NEW_URL);
    const now = (await api(a, 'GET', `/submissions/${d.id}`)).json<SubmissionJson>();
    expect(now).toMatchObject({ status: 'draft', destinationUrl: OLD_URL });
    expect(now.postingChangedAt).not.toBeNull();
    expect(now.reviewDigest).not.toBe(d.digest);
  });

  it('handed off: left exactly as it is', async () => {
    const { app, a } = await boot(ON);
    const d = await reviewed(app, a);
    expect((await handoff(a, d.id)).statusCode).toBe(200);
    const before = await rowOf(app, d.id);
    await changePosting(a, d.oppId, NEW_URL);
    expect(await rowOf(app, d.id)).toEqual(before);
  });

  it('an ATS identity change through reconcile counts too; the same posting again does not', async () => {
    const { app, a } = await boot(ON);
    const ctx = ctxOf(a);
    const same = await reviewed(app, a);
    await confirm(app.db, ctx, await getOpportunity(app.db, ctx, same.oppId), posting(OLD_URL));
    expect(await rowOf(app, same.id)).toMatchObject({ status: 'reviewed', postingChangedAt: null });

    // Another requisition to start from, so the two attempts are not re-applications.
    const elsewhere = {
      ...OLD_REF,
      externalId: '1000003',
      url: 'https://boards.greenhouse.io/examplecorp/jobs/1000003',
    };
    const moved = await reviewed(app, a, elsewhere);
    await confirm(app.db, ctx, await getOpportunity(app.db, ctx, moved.oppId), posting(NEW_URL));
    expect(await rowOf(app, moved.id)).toMatchObject({ status: 'draft' });
    expect((await rowOf(app, moved.id))?.postingChangedAt).not.toBeNull();
  });

  it('an ATS identity change with the URL unchanged counts (setPostingState)', async () => {
    const { app, a } = await boot(ON);
    const d = await reviewed(app, a);
    const other: AtsJobRef = { ...OLD_REF, externalId: '1000009', url: OLD_URL };
    await setPostingState(app.db, ctxOf(a), d.oppId, {
      postingState: 'confirmed',
      postingStateDetail: null,
      atsJobRef: other,
    });
    expect((await getOpportunity(app.db, ctxOf(a), d.oppId)).postingUrl).toBe(OLD_URL);
    expect(await rowOf(app, d.id)).toMatchObject({ status: 'draft' });
    expect((await rowOf(app, d.id))?.postingChangedAt).not.toBeNull();
  });

  it('the backfill correcting a stored identity counts too', async () => {
    const { app, a } = await boot(ON);
    const d = await reviewed(app, a);
    // A stale identity on the opportunity, as before #137; the URL still names OLD_REF's job.
    await app.db
      .update(opportunities)
      .set({ atsJobRef: { ...OLD_REF, externalId: '1000009' } })
      .where(eq(opportunities.id, d.oppId))
      .run();
    expect(await backfillAtsJobRefs(app.db, ctxOf(a))).toMatchObject({ changed: 1 });
    expect(await rowOf(app, d.id)).toMatchObject({ status: 'draft' });
    expect((await rowOf(app, d.id))?.postingChangedAt).not.toBeNull();
  });

  it('an attempt no longer live is not touched', async () => {
    const { app, a } = await boot(ON);
    const d = await draft(app, a);
    expect((await api(a, 'POST', `/submissions/${d.id}/cancel`)).statusCode).toBe(200);
    const before = await rowOf(app, d.id);
    await changePosting(a, d.oppId, NEW_URL);
    expect(await rowOf(app, d.id)).toEqual(before);
  });
});

describe('criterion 3: the old destination is handed off only after a fresh review', () => {
  it('a review from before the change is refused; a fresh one hands off to the pinned destination', async () => {
    const { app, a } = await boot(ON);
    const d = await reviewed(app, a);
    await changePosting(a, d.oppId, NEW_URL);
    // The attempt is a draft again: no handoff on the old review.
    const early = await handoff(a, d.id);
    expect(early.statusCode).toBe(409);
    // The screen that showed the old review: its digest no longer matches.
    const stale = await review(a, d.id, d.digest);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'review_stale' } });
    // A fresh review of the attempt as it stands, the old destination in full.
    const now = (await api(a, 'GET', `/submissions/${d.id}`)).json<SubmissionJson>();
    expect((await review(a, d.id, now.reviewDigest)).statusCode).toBe(200);
    const out = await handoff(a, d.id);
    expect(out.statusCode, out.body).toBe(200);
    expect(out.json()).toMatchObject({ destinationUrl: OLD_URL });
  });
});

describe('criterion 4: a posting change during a review (race), and nothing lost', () => {
  it('a change landing while a review is in flight makes that review stale', async () => {
    const { app, a } = await boot(ON);
    const d = await draft(app, a);
    // The review has read its attempt and is about to open its transaction.
    const pause = pauseAt('submissions.review');
    const inFlight = review(a, d.id, d.digest);
    await pause.reached;
    expect((await changePosting(a, d.oppId, NEW_URL)).statusCode).toBe(200);
    pause.release();
    const res = await inFlight;
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'review_stale' } });
    expect(await rowOf(app, d.id)).toMatchObject({ status: 'draft', reviewedAt: null });
  });

  it('nothing is cancelled or lost: one live attempt, its work intact', async () => {
    const { app, a } = await boot(ON);
    const d = await reviewed(app, a);
    await changePosting(a, d.oppId, NEW_URL);
    await changePosting(a, d.oppId, CAREER_PAGE_URL);
    const rows = await app.db
      .select()
      .from(applicationSubmissions)
      .where(and(eq(applicationSubmissions.opportunityId, d.oppId)))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'draft',
      resumeId: d.resumeId,
      fields: { email: 'jane@example.com' },
      destinationUrl: OLD_URL,
    });
  });
});

describe('the related note: the live attempt is shown, not only a refusal', () => {
  it('a create on an opportunity whose posting went bad answers live_submission_exists, naming it', async () => {
    const { app, a } = await boot(ON);
    const d = await draft(app, a);
    // The posting is now a career page: no ATS identity, which a new draft could not start on.
    await changePosting(a, d.oppId, CAREER_PAGE_URL);
    const res = await api(a, 'POST', `/opportunities/${d.oppId}/submissions`, {
      idempotencyKey: crypto.randomUUID(),
      resumeId: d.resumeId,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: { code: 'live_submission_exists', submissionId: d.id },
    });
  });
});
