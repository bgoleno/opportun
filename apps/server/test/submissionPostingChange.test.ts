// A posting change under a live attempt (https://github.com/bgoleno/opportun/issues/144, the
// owner's option A): the attempt keeps its pinned destination and the user's work, a review
// goes back to draft, and a review screen shown before the change cannot be confirmed.
// Organised by the issue's acceptance criteria. Every URL is synthetic; nothing is fetched.
import { confirm } from '../src/lib/postingReconcile';
import { newId, type AtsJobRef, type NormalizedPosting } from '@opportun/core';
import { and, count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { applicationSubmissions, auditLog, opportunities, resumes } from '../src/db/schema';
import type { UserCtx } from '../src/repos/base';
import {
  createOpportunity,
  getOpportunity,
  mergeOpportunities,
  setPostingState,
} from '../src/repos/opportunities';
import { backfillAtsJobRefs } from '../src/jobs/atsJobRefBackfill';
import { withTransaction } from '../src/db/client';
import { insertResume } from '../src/repos/resumes';
import { lockLiveAttempt, markPostingChanged } from '../src/repos/submissions';
import { submissionDigest } from '../src/lib/submissionDigest';
import { useApi } from './api';
import type { TestClient } from './isolation';
import { heldApart } from './race';

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
    title: `Senior Example Engineer ${newId()}`,
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
  it('a change while a review holds its locks waits for it, then sends the attempt back to draft', async () => {
    const { app, a } = await boot(ON);
    const d = await draft(app, a);
    // The review is inside both its locks, every check done, about to write (tl on #154); the
    // change must be seen waiting, not run past it.
    const [r, c] = await heldApart(
      app,
      'submissions.review.locked',
      () => review(a, d.id, d.digest),
      () => changePosting(a, d.oppId, NEW_URL),
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(c.statusCode, c.body).toBe(200);
    // The review landed first; the change then sent it back to draft.
    const row = await rowOf(app, d.id);
    expect(row).toMatchObject({ status: 'draft', reviewDigest: null });
    expect(row?.postingChangedAt).not.toBeNull();
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

describe('the digest of an attempt whose posting never changed is what it always was (tl on #154)', () => {
  const input = {
    userId: 'u-1',
    opportunityId: 'o-1',
    resumeId: 'r-1',
    resumeSha256: null,
    destinationUrl: 'https://boards.greenhouse.io/examplecorp/jobs/1000001',
    atsKind: 'ats_greenhouse',
    atsExternalId: '1000001',
    fields: { email: 'jane@example.com' },
    answers: [{ questionKey: 'why', label: 'Why us?', value: 'Latex.', source: 'user' as const }],
  };
  // Computed with main's submissionDigest (e8e8b36), before posting_changed_at existed.
  const BEFORE_144 = '3c5065e8dc16147b470d4c90d7ebe852d98abd5025a0ae6b51e39fbdb25ec0cc';

  it('absent or null: the same digest as before #144; set: a different one', () => {
    expect(submissionDigest(input)).toBe(BEFORE_144);
    expect(submissionDigest({ ...input, postingChangedAt: null })).toBe(BEFORE_144);
    expect(submissionDigest({ ...input, postingChangedAt: 1_800_000_000_000 })).not.toBe(
      BEFORE_144,
    );
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

describe('lock order: the attempt, then the user, then rows (tl on #154; the deadlocks are Postgres)', () => {
  // With the old order these pairs deadlock on Postgres (40P01, one request a 500). On SQLite the
  // write gate serialises them either way; CI's Postgres leg is the guard.
  it('an edit naming the company and the posting, against a review holding only the attempt lock: both finish', async () => {
    const { app, a } = await boot(ON);
    const d = await draft(app, a);
    const [r, e] = await heldApart(
      app,
      'submissions.review.attemptLocked', // the attempt's lock held, not yet the user's
      () => review(a, d.id, d.digest),
      () =>
        api(a, 'PATCH', `/opportunities/${d.oppId}`, {
          companyName: 'Example Corp', // findOrCreateCompanySync takes the user's lock
          postingUrl: NEW_URL,
        }),
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(e.statusCode, e.body).toBe(200);
    expect(await rowOf(app, d.id)).toMatchObject({ status: 'draft' });
  });

  // #889: whether the link changes is read again under the user's lock, so the attempt's lock has
  // to be held already by a save that sends the link it last saw. A link alone (what the opportunity
  // page sends) waits on the attempt's lock and decides after it, as a link with a title does (tl on
  // #910).
  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ['a link and a title', { title: 'One' }, { title: 'Two' }],
    ['a link alone', {}, {}],
    ['a link alone, after a link and a title', { title: 'One' }, {}],
    ['a link and a title, after a link alone', {}, { title: 'Two' }],
  ])(
    'an edit sending back the link it saw, after another changed it: the attempt is marked both times (%s)',
    async (_w, one, two) => {
      const { app, a } = await boot(ON);
      const d = await reviewed(app, a);
      const [first, second] = await heldApart(
        app,
        'opportunities.update.locked',
        () => api(a, 'PATCH', `/opportunities/${d.oppId}`, { ...one, postingUrl: NEW_URL }),
        () => api(a, 'PATCH', `/opportunities/${d.oppId}`, { ...two, postingUrl: OLD_URL }),
      );
      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(200);
      const opp = await getOpportunity(app.db, ctxOf(a), d.oppId);
      // The link and the identity are one link's: the second save's.
      expect(opp).toMatchObject({ ...one, ...two, postingUrl: OLD_URL });
      expect(opp.atsJobRef).toMatchObject({ externalId: OLD_REF.externalId });
      const [marks] = await app.db
        .select({ n: count() })
        .from(auditLog)
        .where(and(eq(auditLog.userId, a.userId), eq(auditLog.event, 'submission.posting_changed')))
        .all();
      expect(marks?.n).toBe(2);
    },
  );

  it('a merge moving the live attempt, against an edit of the merged-away opportunity: both finish', async () => {
    const { app, a } = await boot(ON);
    const d = await draft(app, a); // the live attempt is on d.oppId, the one merged away
    const keep = await createOpportunity(app.db, ctxOf(a), {
      companyName: 'Example Corp',
      title: `Senior Example Engineer ${newId()}`,
      sourceKind: 'manual',
    });
    const [merged, e] = await heldApart(
      app,
      'opportunities.merge.moved', // moved, the merged-away opportunity not yet deleted
      () => mergeOpportunities(app.db, ctxOf(a), keep.id, d.oppId),
      () => changePosting(a, d.oppId, NEW_URL),
    );
    expect(merged.id).toBe(keep.id);
    // The merge won; the edit then finds its opportunity merged away. Never a 500.
    expect(e.statusCode, e.body).toBe(404);
    expect(await rowOf(app, d.id)).toMatchObject({ opportunityId: keep.id, status: 'draft' });
  });
});

// https://github.com/bgoleno/opportun/issues/1055: the draft goes on to where it was started for, and the
// opportunity it is on now names another job, as after a saved link.
describe('a merge that moves it to another job asks for another review (#1055)', () => {
  const NEW_REF: AtsJobRef = { ...OLD_REF, externalId: '2000002', url: NEW_URL };

  /** The one that is kept, at `ref`, or with no posting identity, and only a link if any. */
  async function kept(
    app: FastifyInstance,
    c: TestClient,
    ref: AtsJobRef | null,
    link: string | null = ref?.url ?? null,
  ) {
    const { id } = await createOpportunity(app.db, ctxOf(c), {
      companyName: 'Example Corp',
      title: `Senior Example Engineer ${newId()}`,
      sourceKind: 'manual',
    });
    await app.db
      .update(opportunities)
      .set({
        atsJobRef: ref,
        postingUrl: link,
        postingState: ref === null ? null : 'confirmed',
      })
      .where(eq(opportunities.id, id))
      .run();
    return id;
  }
  const merge = async (c: TestClient, keepId: string, otherId: string) => {
    const res = await api(c, 'POST', `/opportunities/${keepId}/merge`, { otherId });
    expect(res.statusCode, res.body).toBe(200);
  };
  const audited = async (app: FastifyInstance, event: string) =>
    (await app.db.select().from(auditLog).where(eq(auditLog.event, event)).all()).map((r) => [
      r.userId,
      r.detail,
    ]);
  const marks = (app: FastifyInstance) => audited(app, 'submission.posting_changed');
  const merges = (app: FastifyInstance) => audited(app, 'submission.review_lapsed');

  it('reviewed: back to draft, its review lapsed, recorded; the destination and the work kept', async () => {
    const { app, a } = await boot(ON);
    const d = await reviewed(app, a);
    const keepId = await kept(app, a, NEW_REF);
    const before = await rowOf(app, d.id);
    await merge(a, keepId, d.oppId);
    const row = await rowOf(app, d.id);
    expect(row?.postingChangedAt).not.toBeNull();
    expect(row).toEqual({
      ...before,
      opportunityId: keepId,
      status: 'draft',
      reviewDigest: null,
      reviewExpiresAt: null,
      postingChangedAt: row?.postingChangedAt,
      updatedAt: row?.updatedAt,
    });
    expect(row).toMatchObject({ destinationUrl: OLD_URL, atsExternalId: '1000001' });
    expect(await marks(app)).toEqual([
      [a.userId, { submissionId: d.id, opportunityId: keepId, from: 'reviewed' }],
    ]);
    expect(await merges(app)).toEqual([]);
  });

  it('a draft: marked too, so the screen open before cannot be confirmed', async () => {
    const { app, a } = await boot(ON);
    const d = await draft(app, a);
    const keepId = await kept(app, a, NEW_REF);
    await merge(a, keepId, d.oppId);
    expect(await marks(app)).toEqual([
      [a.userId, { submissionId: d.id, opportunityId: keepId, from: 'draft' }],
    ]);
    const stale = await review(a, d.id, d.digest);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'review_stale' } });
  });

  it('a review from before it answers as after a saved link; a fresh one hands off where it was pinned', async () => {
    const { app, a } = await boot(ON);
    const merged = await reviewed(app, a);
    const saved = await reviewed(app, a, {
      ...OLD_REF,
      externalId: '1000004',
      url: 'https://boards.greenhouse.io/examplecorp/jobs/1000004',
    });
    await merge(a, await kept(app, a, NEW_REF), merged.oppId);
    expect((await changePosting(a, saved.oppId, NEW_URL)).statusCode).toBe(200);
    const answers = async (d: typeof merged) => {
      const early = await handoff(a, d.id);
      const stale = await review(a, d.id, d.digest);
      // The attempt named apart.
      return JSON.parse(
        JSON.stringify([early.statusCode, early.json(), stale.statusCode, stale.json()]).replaceAll(
          d.id,
          'it',
        ),
      ) as unknown;
    };
    const said = await answers(merged);
    expect(said).toMatchObject([409, {}, 409, { error: { code: 'review_stale' } }]);
    expect(said).toEqual(await answers(saved));
    const now = (await api(a, 'GET', `/submissions/${merged.id}`)).json<SubmissionJson>();
    expect((await review(a, merged.id, now.reviewDigest)).statusCode).toBe(200);
    const out = await handoff(a, merged.id);
    expect(out.statusCode, out.body).toBe(200);
    expect(out.json()).toMatchObject({ destinationUrl: OLD_URL });
  });

  it.each([
    ['another site', { ...OLD_REF, kind: 'ats_lever', url: 'https://jobs.lever.co/examplecorp/1' }],
    ['another company', { ...OLD_REF, org: 'othercorp' }],
    ['no company', { ...OLD_REF, org: null }],
  ] as [string, AtsJobRef][])('the kept one is of %s: marked', async (_, ref) => {
    const { app, a } = await boot(ON);
    const d = await reviewed(app, a);
    await merge(a, await kept(app, a, ref), d.oppId);
    expect(await rowOf(app, d.id)).toMatchObject({ status: 'draft', reviewDigest: null });
    expect(await marks(app)).toHaveLength(1);
  });

  it.each([
    ['another job', NEW_URL],
    ['another job on a careers page', CAREER_PAGE_URL],
    ['another company’s job of that id', OLD_URL.replace('examplecorp', 'othercorp')],
    [
      'another site’s job',
      'https://jobs.lever.co/examplecorp/6b1f6a0e-7a0b-4a53-9c7d-2f6a8f1f0c11',
    ],
  ])('the kept one has only a link, which names %s: marked', async (_, link) => {
    const { app, a } = await boot(ON);
    const d = await reviewed(app, a);
    await merge(a, await kept(app, a, null, link), d.oppId);
    expect(await rowOf(app, d.id)).toMatchObject({ status: 'draft', reviewDigest: null });
    expect(await marks(app)).toHaveLength(1);
    expect(await merges(app)).toEqual([]);
  });

  it.each([
    ['no link', null],
    ['a link no site reads', 'https://www.examplecorp.example/careers/1000001'],
    ['a link to a board, and no job', 'https://boards.greenhouse.io/examplecorp'],
    ['the same link, not confirmed', OLD_URL],
    ['the same job on a careers page', 'https://www.examplecorp.example/careers?gh_jid=1000001'],
  ])(
    'the kept one names no other job (%s): a draft to review again, with no mark',
    async (_, link) => {
      const { app, a } = await boot(ON);
      const d = await reviewed(app, a);
      const keepId = await kept(app, a, null, link);
      await merge(a, keepId, d.oppId);
      expect(await rowOf(app, d.id)).toMatchObject({
        opportunityId: keepId,
        status: 'draft',
        reviewDigest: null,
        postingChangedAt: null,
      });
      expect(await marks(app)).toEqual([]);
      expect(await merges(app)).toHaveLength(1);
    },
  );

  it('a stored identity counts before the link', async () => {
    const { app, a } = await boot(ON);
    const d = await reviewed(app, a);
    await merge(a, await kept(app, a, OLD_REF, NEW_URL), d.oppId);
    expect(await marks(app)).toEqual([]);
    expect(await merges(app)).toHaveLength(1);
  });

  const SAME_JOB: [string, AtsJobRef][] = [
    [
      'another link',
      { ...OLD_REF, url: 'https://job-boards.greenhouse.io/examplecorp/jobs/1000001?gh_src=x' },
    ],
    ['its company written otherwise', { ...OLD_REF, org: 'ExampleCorp' }],
  ];

  // The digest covers the opportunity's id, so no review from before a merge can be handed off.
  it.each(SAME_JOB)(
    'the same job, under %s: a draft to review again, with no mark, and it can be',
    async (_, ref) => {
      const { app, a } = await boot(ON);
      const d = await reviewed(app, a);
      const keepId = await kept(app, a, ref);
      const before = await rowOf(app, d.id);
      await merge(a, keepId, d.oppId);
      const row = await rowOf(app, d.id);
      expect(row).toEqual({
        ...before,
        opportunityId: keepId,
        status: 'draft',
        reviewDigest: null,
        reviewExpiresAt: null,
        updatedAt: row?.updatedAt,
      });
      expect(await marks(app)).toEqual([]);
      expect(await merges(app)).toEqual([
        [
          a.userId,
          { submissionId: d.id, opportunityId: keepId, from: 'reviewed', cause: 'merged' },
        ],
      ]);
      const stale = await review(a, d.id, d.digest);
      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json()).toMatchObject({ error: { code: 'review_stale' } });
      const now = (await api(a, 'GET', `/submissions/${d.id}`)).json<SubmissionJson>();
      expect((await review(a, d.id, now.reviewDigest)).statusCode).toBe(200);
      const out = await handoff(a, d.id);
      expect(out.statusCode, out.body).toBe(200);
      expect(out.json()).toMatchObject({ destinationUrl: OLD_URL });
    },
  );

  it.each(SAME_JOB)(
    'the same job, under %s: a draft not reviewed moves as it is',
    async (_, ref) => {
      const { app, a } = await boot(ON);
      const d = await draft(app, a);
      const keepId = await kept(app, a, ref);
      const before = await rowOf(app, d.id);
      await merge(a, keepId, d.oppId);
      expect(await rowOf(app, d.id)).toEqual({ ...before, opportunityId: keepId });
      expect([...(await marks(app)), ...(await merges(app))]).toEqual([]);
      const stale = await review(a, d.id, d.digest);
      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json()).toMatchObject({ error: { code: 'review_stale' } });
    },
  );

  describe.each([
    ['another job', NEW_REF],
    ['the same job', OLD_REF],
  ])('with one of %s', (_, ref) => {
    it('the kept one’s own draft stays reviewed, and is handed off', async () => {
      const { app, a } = await boot(ON);
      const d = await reviewed(app, a);
      const before = await rowOf(app, d.id);
      await merge(a, d.oppId, await kept(app, a, ref));
      expect(await rowOf(app, d.id)).toEqual(before);
      expect([...(await marks(app)), ...(await merges(app))]).toEqual([]);
      const out = await handoff(a, d.id);
      expect(out.statusCode, out.body).toBe(200);
    });

    it('one handed off moves as it is', async () => {
      const { app, a } = await boot(ON);
      const d = await reviewed(app, a);
      expect((await handoff(a, d.id)).statusCode).toBe(200);
      const before = await rowOf(app, d.id);
      const keepId = await kept(app, a, ref);
      await merge(a, keepId, d.oppId);
      expect(await rowOf(app, d.id)).toEqual({ ...before, opportunityId: keepId });
      expect([...(await marks(app)), ...(await merges(app))]).toEqual([]);
    });

    it.each(['submitted', 'abandoned'] as const)('one %s moves as it is', async (status) => {
      const { app, a } = await boot(ON);
      const d = await reviewed(app, a);
      await app.db
        .update(applicationSubmissions)
        .set({ status })
        .where(eq(applicationSubmissions.id, d.id))
        .run();
      const before = await rowOf(app, d.id);
      const keepId = await kept(app, a, ref);
      await merge(a, keepId, d.oppId);
      expect(await rowOf(app, d.id)).toEqual({ ...before, opportunityId: keepId });
      expect([...(await marks(app)), ...(await merges(app))]).toEqual([]);
    });
  });

  it.each([
    ['another job', NEW_REF],
    ['the same job', OLD_REF],
  ])(
    'moved to %s: its place under the daily cap is neither freed nor taken twice',
    async (_, ref) => {
      const { app, a } = await boot(ON);
      const used = async () =>
        (await api(a, 'GET', '/settings/applications')).json<{ used: number }>().used;
      const d = await reviewed(app, a);
      expect(await used()).toBe(1);
      await merge(a, await kept(app, a, ref), d.oppId);
      expect(await used()).toBe(1);
      const now = (await api(a, 'GET', `/submissions/${d.id}`)).json<SubmissionJson>();
      expect((await review(a, d.id, now.reviewDigest)).statusCode).toBe(200);
      expect(await used()).toBe(1);
    },
  );

  it('started for another site, company and job: its own is what it is compared with', async () => {
    const { app, a } = await boot(ON);
    const job = '6b1f6a0e-7a0b-4a53-9c7d-2f6a8f1f0c11';
    const lever: AtsJobRef = {
      kind: 'ats_lever',
      org: 'othercorp',
      externalId: job,
      url: `https://jobs.lever.co/othercorp/${job}`,
    };
    const same = await reviewed(app, a, lever);
    await merge(a, await kept(app, a, lever), same.oppId);
    expect(await marks(app)).toEqual([]);
    expect(await merges(app)).toHaveLength(1);
    expect(await rowOf(app, same.id)).toMatchObject({ status: 'draft', postingChangedAt: null });
  });

  it('it is the posting of the kept one that counts, not what its own was changed to', async () => {
    const { app, a } = await boot(ON);
    const d = await reviewed(app, a);
    await changePosting(a, d.oppId, NEW_URL);
    const now = (await api(a, 'GET', `/submissions/${d.id}`)).json<SubmissionJson>();
    expect((await review(a, d.id, now.reviewDigest)).statusCode).toBe(200);
    const { postingChangedAt } = (await rowOf(app, d.id))!;
    await merge(a, await kept(app, a, OLD_REF), d.oppId);
    expect(await rowOf(app, d.id)).toMatchObject({ status: 'draft', postingChangedAt });
    expect(await marks(app)).toHaveLength(1);
  });

  it('a link saved on the kept one while the merge waits is the one compared with', async () => {
    const { app, a } = await boot(ON);
    const d = await reviewed(app, a);
    const keepId = await kept(app, a, OLD_REF);
    const [saved] = await heldApart(
      app,
      'opportunities.update.locked',
      () => changePosting(a, keepId, NEW_URL),
      () => mergeOpportunities(app.db, ctxOf(a), keepId, d.oppId),
    );
    expect(saved.statusCode, saved.body).toBe(200);
    expect(await rowOf(app, d.id)).toMatchObject({ opportunityId: keepId, status: 'draft' });
    expect(await marks(app)).toHaveLength(1);
  });

  it('a review confirmed while the merge is under way is refused, once it is done', async () => {
    const { app, a } = await boot(ON);
    const d = await draft(app, a);
    const keepId = await kept(app, a, NEW_REF);
    const [, stale] = await heldApart(
      app,
      'opportunities.merge.moved',
      () => mergeOpportunities(app.db, ctxOf(a), keepId, d.oppId),
      () => review(a, d.id, d.digest),
    );
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'review_stale' } });
    expect(await rowOf(app, d.id)).toMatchObject({ opportunityId: keepId, status: 'draft' });
  });
});

describe('the attempt the lock was taken on is the one marked (#157)', () => {
  it('lockLiveAttempt returns the id it locked, or null with no live attempt', async () => {
    const { app, a } = await boot(ON);
    const d = await reviewed(app, a);
    const locked = await withTransaction(app.db, (tx) => lockLiveAttempt(tx, ctxOf(a), d.oppId));
    expect(locked).toBe(d.id);
    const other = await createOpportunity(app.db, ctxOf(a), {
      companyName: 'Example Corp',
      title: 'No attempt here',
      sourceKind: 'manual',
    });
    expect(
      await withTransaction(app.db, (tx) => lockLiveAttempt(tx, ctxOf(a), other.id)),
    ).toBeNull();
  });

  it('markPostingChanged acts on the id it is given, with no lookup of its own', async () => {
    const { app, a } = await boot(ON);
    const d = await reviewed(app, a);
    const now = Date.now();
    await withTransaction(app.db, async (tx) => {
      const locked = await lockLiveAttempt(tx, ctxOf(a), d.oppId);
      await markPostingChanged(tx, ctxOf(a), locked, d.oppId, now);
    });
    expect(await rowOf(app, d.id)).toMatchObject({ status: 'draft', postingChangedAt: now });
    // Given no attempt (null), nothing is looked up and nothing changes.
    const e = await reviewed(app, a);
    await withTransaction(app.db, (tx) => markPostingChanged(tx, ctxOf(a), null, e.oppId, now));
    expect(await rowOf(app, e.id)).toMatchObject({ status: 'reviewed', postingChangedAt: null });
  });

  it("given one opportunity's attempt and another's opportunity id, only the given attempt changes (#170)", async () => {
    // Two live attempts, on opportunities A and B. The id is the one A's lock returned, while the
    // opportunity id is B's. A lookup of B's live attempt (the code before #157) would mark B's
    // attempt and leave A's alone; acting on the id given marks A's and only A's.
    const { app, a } = await boot(ON);
    const onA = await reviewed(app, a);
    // B starts from another requisition, so its attempt is not a re-application of A's.
    const onB = await reviewed(app, a, {
      ...OLD_REF,
      externalId: '1000004',
      url: 'https://boards.greenhouse.io/examplecorp/jobs/1000004',
    });
    const now = Date.now();
    await withTransaction(app.db, async (tx) => {
      const lockedA = await lockLiveAttempt(tx, ctxOf(a), onA.oppId);
      expect(lockedA).toBe(onA.id);
      await markPostingChanged(tx, ctxOf(a), lockedA, onB.oppId, now);
    });
    expect(await rowOf(app, onA.id)).toMatchObject({ status: 'draft', postingChangedAt: now });
    expect(await rowOf(app, onB.id)).toMatchObject({
      status: 'reviewed',
      postingChangedAt: null,
      reviewDigest: onB.digest,
    });
    const audits = await app.db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(eq(auditLog.event, 'submission.posting_changed'))
      .all();
    expect(audits.map((r) => r.detail?.submissionId)).toEqual([onA.id]);
  });
});
