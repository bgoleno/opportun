// Application submissions, the draft lifecycle (assisted apply M1a,
// https://github.com/bgoleno/opportun/issues/114). Organised by the issue's acceptance criteria.
// Every opportunity and resume here is synthetic. Nothing here, or in the code under test,
// contacts an employer or an ATS: the posting URL is stored, never fetched.
import { newId, type AtsJobRef, type OpportunityStage } from '@opportun/core';
import { and, eq, like } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { isUniqueViolation } from '../src/db/client';
import { applicationSubmissions, auditLog, jobs, opportunities, resumes } from '../src/db/schema';
import type { UserCtx } from '../src/repos/base';
import { createOpportunity } from '../src/repos/opportunities';
import { createSubmissionDraft } from '../src/repos/submissions';
import { setRaceHook } from '../src/lib/racePoints';
import { insertResume } from '../src/repos/resumes';
import { useApi } from './api';
import { assertIsolated, type TestClient } from './isolation';
import { holdAt } from './race';

const ON = { submissions: true };
const boot = useApi();
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });

const ATS_REF: AtsJobRef = {
  kind: 'ats_greenhouse',
  org: 'examplecorp',
  externalId: '1000001',
  url: 'https://boards.greenhouse.io/examplecorp/jobs/1000001',
};

/**
 * An opportunity at `stage`, with `ats` as its ATS identity (none when null) and the posting
 * confirmed, as a board search that matched would leave it (`postingState` overrides it).
 */
async function seedOpportunity(
  app: FastifyInstance,
  c: TestClient,
  opts: {
    stage?: OpportunityStage;
    ats?: AtsJobRef | null;
    title?: string;
    postingState?: 'searching' | 'confirmed' | 'needs_review' | null;
  } = {},
): Promise<string> {
  const opp = await createOpportunity(app.db, ctxOf(c), {
    companyName: 'Example Corp',
    title: opts.title ?? `Senior Example Engineer ${newId().slice(-6)}`,
    sourceKind: 'manual',
  });
  await app.db
    .update(opportunities)
    .set({
      stage: opts.stage ?? 'interested',
      atsJobRef: opts.ats === undefined ? ATS_REF : opts.ats,
      postingState: opts.postingState === undefined ? 'confirmed' : opts.postingState,
    })
    .where(eq(opportunities.id, opp.id))
    .run();
  return opp.id;
}

async function seedResume(
  app: FastifyInstance,
  c: TestClient,
  status: 'draft' | 'in_review' | 'final' | 'submitted' = 'final',
): Promise<string> {
  const r = await insertResume(app.db, ctxOf(c), {
    kind: 'base',
    title: 'Example Resume',
    store: 'local_file',
    docRef: `resumes/${newId()}.txt`,
    opportunityId: null,
    parentResumeId: null,
  });
  await app.db.update(resumes).set({ status }).where(eq(resumes.id, r.id)).run();
  return r.id;
}

const create = (c: TestClient, oppId: string, body: Record<string, unknown>) =>
  c.request({ method: 'POST', url: `/api/v1/opportunities/${oppId}/submissions`, payload: body });

async function rowsFor(app: FastifyInstance, c: TestClient) {
  return await app.db
    .select()
    .from(applicationSubmissions)
    .where(eq(applicationSubmissions.userId, c.userId))
    .all();
}

/** A ready eligible opportunity and final resume, and one draft for them. */
async function draft(app: FastifyInstance, c: TestClient) {
  const oppId = await seedOpportunity(app, c);
  const resumeId = await seedResume(app, c);
  const res = await create(c, oppId, { idempotencyKey: crypto.randomUUID(), resumeId });
  expect(res.statusCode, res.body).toBe(201);
  return { oppId, resumeId, submission: res.json() as { id: string; status: string } };
}

describe('AC1: one draft per eligible opportunity', () => {
  it('creates a draft from the opportunity’s ATS identity and the chosen final resume', async () => {
    const { app, a } = await boot(ON);
    const oppId = await seedOpportunity(app, a, { stage: 'preparing' });
    const resumeId = await seedResume(app, a);
    const res = await create(a, oppId, { idempotencyKey: crypto.randomUUID(), resumeId });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      opportunityId: oppId,
      resumeId,
      status: 'draft',
      atsKind: 'ats_greenhouse',
      atsRef: 'examplecorp',
      atsExternalId: '1000001',
      destinationUrl: 'https://boards.greenhouse.io/examplecorp/jobs/1000001',
      resumeTitle: 'Example Resume',
      resumeStore: 'local_file',
      fields: {},
      answers: [],
      reviewedAt: null,
      submittedAt: null,
    });
  });

  it.each(['interested', 'preparing', 'applied'] as const)('accepts stage %s', async (stage) => {
    const { app, a } = await boot(ON);
    const oppId = await seedOpportunity(app, a, { stage });
    const res = await create(a, oppId, {
      idempotencyKey: crypto.randomUUID(),
      resumeId: await seedResume(app, a),
    });
    expect(res.statusCode, res.body).toBe(201);
  });

  it('a repeat create with the same key returns the same draft, marked as a replay', async () => {
    const { app, a } = await boot(ON);
    const oppId = await seedOpportunity(app, a);
    const resumeId = await seedResume(app, a);
    const body = { idempotencyKey: crypto.randomUUID(), resumeId };
    const first = await create(a, oppId, body);
    const again = await create(a, oppId, body);
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json().id).toBe(first.json().id);
    expect(await rowsFor(app, a)).toHaveLength(1);
  });

  it('a key already used for another opportunity is refused', async () => {
    const { app, a } = await boot(ON);
    const resumeId = await seedResume(app, a);
    const key = crypto.randomUUID();
    expect(
      (await create(a, await seedOpportunity(app, a), { idempotencyKey: key, resumeId }))
        .statusCode,
    ).toBe(201);
    const other = await create(a, await seedOpportunity(app, a), { idempotencyKey: key, resumeId });
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('idempotency_key_reused');
    expect(await rowsFor(app, a)).toHaveLength(1);
  });

  it.each([
    ['no ATS identity', { ats: null }, 'no_ats_identity'],
    ['stage discovered', { stage: 'discovered' as const }, 'stage_not_eligible'],
    ['stage in_process', { stage: 'in_process' as const }, 'stage_not_eligible'],
    ['stage offer', { stage: 'offer' as const }, 'stage_not_eligible'],
    ['stage dismissed', { stage: 'dismissed' as const }, 'stage_not_eligible'],
    ['stage closed', { stage: 'closed' as const }, 'stage_not_eligible'],
    [
      'an http posting URL',
      { ats: { ...ATS_REF, url: 'http://boards.greenhouse.io/examplecorp/jobs/1000001' } },
      'destination_not_https',
    ],
  ])('an opportunity with %s gets 422 %s and nothing is created', async (_n, opts, code) => {
    const { app, a } = await boot(ON);
    const oppId = await seedOpportunity(app, a, opts);
    const res = await create(a, oppId, {
      idempotencyKey: crypto.randomUUID(),
      resumeId: await seedResume(app, a),
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe(code);
    expect(await rowsFor(app, a)).toEqual([]);
  });

  // tl review of #124: "final" means finished. A submitted resume (already sent with another
  // application) is reused for many applications, so it is accepted too.
  it.each(['final', 'submitted'] as const)('a resume marked %s is accepted', async (status) => {
    const { app, a } = await boot(ON);
    const res = await create(a, await seedOpportunity(app, a), {
      idempotencyKey: crypto.randomUUID(),
      resumeId: await seedResume(app, a, status),
    });
    expect(res.statusCode, res.body).toBe(201);
  });

  it.each([
    ['searching', 'searching' as const],
    ['needs review (reconciled away, or unconfirmed)', 'needs_review' as const],
    ['never searched', null],
  ])(
    'a posting %s, with its ATS ref still in place, gets 422 posting_not_confirmed',
    async (_n, postingState) => {
      const { app, a } = await boot(ON);
      const oppId = await seedOpportunity(app, a, {
        postingState,
      });
      const res = await create(a, oppId, {
        idempotencyKey: crypto.randomUUID(),
        resumeId: await seedResume(app, a),
      });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().error.code).toBe('posting_not_confirmed');
      expect(await rowsFor(app, a)).toEqual([]);
    },
  );

  it('the same key with a different resume is refused, never answered with the first choice', async () => {
    const { app, a } = await boot(ON);
    const oppId = await seedOpportunity(app, a);
    const key = crypto.randomUUID();
    const first = await create(a, oppId, {
      idempotencyKey: key,
      resumeId: await seedResume(app, a),
    });
    expect(first.statusCode).toBe(201);
    const other = await create(a, oppId, {
      idempotencyKey: key,
      resumeId: await seedResume(app, a),
    });
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('idempotency_key_reused');
    expect(await rowsFor(app, a)).toHaveLength(1);
  });

  it.each(['draft', 'in_review'] as const)(
    'a resume marked %s gets 422 resume_not_final',
    async (status) => {
      const { app, a } = await boot(ON);
      const res = await create(a, await seedOpportunity(app, a), {
        idempotencyKey: crypto.randomUUID(),
        resumeId: await seedResume(app, a, status),
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('resume_not_final');
      expect(await rowsFor(app, a)).toEqual([]);
    },
  );

  it('another user’s resume, or an archived one, reads as not found', async () => {
    const { app, a, b } = await boot(ON);
    const oppId = await seedOpportunity(app, a);
    const theirs = await create(a, oppId, {
      idempotencyKey: crypto.randomUUID(),
      resumeId: await seedResume(app, b),
    });
    expect(theirs.statusCode).toBe(422);
    expect(theirs.json().error.code).toBe('resume_not_found');
    const archived = await seedResume(app, a);
    await app.db
      .update(resumes)
      .set({ archivedAt: Date.now() })
      .where(eq(resumes.id, archived))
      .run();
    const res = await create(a, oppId, { idempotencyKey: crypto.randomUUID(), resumeId: archived });
    expect(res.json().error.code).toBe('resume_not_found');
    expect(await rowsFor(app, a)).toEqual([]);
  });

  it('an opportunity that does not exist is 404', async () => {
    const { app, a } = await boot(ON);
    const res = await create(a, newId(), {
      idempotencyKey: crypto.randomUUID(),
      resumeId: await seedResume(app, a),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('AC2: one live submission per opportunity', () => {
  it('a second create while a draft is live is 409 and names the live one', async () => {
    const { app, a } = await boot(ON);
    const { oppId, resumeId, submission } = await draft(app, a);
    const second = await create(a, oppId, { idempotencyKey: crypto.randomUUID(), resumeId });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatchObject({
      code: 'live_submission_exists',
      submissionId: submission.id,
    });
    expect(await rowsFor(app, a)).toHaveLength(1);
  });

  it.each(['reviewed', 'handed_off'] as const)('a %s attempt is live too', async (status) => {
    const { app, a } = await boot(ON);
    const { oppId, resumeId, submission } = await draft(app, a);
    await app.db
      .update(applicationSubmissions)
      .set({ status })
      .where(eq(applicationSubmissions.id, submission.id))
      .run();
    const second = await create(a, oppId, { idempotencyKey: crypto.randomUUID(), resumeId });
    expect(second.statusCode).toBe(409);
  });

  it('after a cancel, a new attempt can start', async () => {
    const { app, a } = await boot(ON);
    const { oppId, resumeId, submission } = await draft(app, a);
    const cancel = await a.request({
      method: 'POST',
      url: `/api/v1/submissions/${submission.id}/cancel`,
    });
    expect(cancel.statusCode, cancel.body).toBe(200);
    const next = await create(a, oppId, { idempotencyKey: crypto.randomUUID(), resumeId });
    expect(next.statusCode, next.body).toBe(201);
    expect(await rowsFor(app, a)).toHaveLength(2);
  });

  it('the partial unique index itself refuses a second live row, whatever the code does', async () => {
    // Constructed directly, past the repo's own check: the index is the enforcement.
    const { app, a } = await boot(ON);
    const { submission } = await draft(app, a);
    const [row] = await app.db
      .select()
      .from(applicationSubmissions)
      .where(eq(applicationSubmissions.id, submission.id))
      .all();
    const insert = (status: 'draft' | 'reviewed' | 'handed_off' | 'abandoned') =>
      app.db
        .insert(applicationSubmissions)
        .values({ ...row!, id: newId(), idempotencyKey: crypto.randomUUID(), status })
        .run();
    for (const status of ['draft', 'reviewed', 'handed_off'] as const) {
      const err = await insert(status).then(
        () => null,
        (e: unknown) => e,
      );
      expect(isUniqueViolation(err), status).toBe(true);
    }
    // A finished attempt is not live: it may sit beside the live one.
    await insert('abandoned');
    const live = await app.db
      .select()
      .from(applicationSubmissions)
      .where(
        and(
          eq(applicationSubmissions.opportunityId, row!.opportunityId),
          eq(applicationSubmissions.status, 'draft'),
        ),
      )
      .all();
    expect(live).toHaveLength(1);
  });
});

describe('AC3: one id per request; strict bodies', () => {
  it.each([
    ['an unknown key', { extra: 1 }],
    ['an id array', { opportunityIds: ['a', 'b'] }],
    ['an array where one id belongs', { resumeId: ['a', 'b'] }],
    ['a key that is not a uuid', { idempotencyKey: 'not-a-uuid' }],
  ])('create with %s is 422 and creates nothing', async (_n, extra) => {
    const { app, a } = await boot(ON);
    const oppId = await seedOpportunity(app, a);
    const res = await create(a, oppId, {
      idempotencyKey: crypto.randomUUID(),
      resumeId: await seedResume(app, a),
      ...extra,
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe('validation');
    // The same body a 400 carries elsewhere: every issue, each with its path from the body.
    const issues = res.json().error.issues as { path: unknown[]; code: string; message: string }[];
    expect(issues.length).toBeGreaterThan(0);
    for (const i of issues) {
      expect(i.path[0]).toBe('body');
      expect(typeof i.code).toBe('string');
      expect(typeof i.message).toBe('string');
    }
    expect(await rowsFor(app, a)).toEqual([]);
  });

  it.each([
    ['an unknown key', { fields: {}, extra: 1 }],
    ['an id array', { ids: ['a', 'b'] }],
    ['an empty body', {}],
    ['a field name that is not an identifier', { fields: { 'not a key': 'x' } }],
    [
      'an answer with an unknown key',
      { answers: [{ questionKey: 'q', label: 'Q', value: 'v', source: 'user', extra: 1 }] },
    ],
  ])('a PATCH with %s is 422 and changes nothing', async (_n, body) => {
    const { app, a } = await boot(ON);
    const { submission } = await draft(app, a);
    const before = await rowsFor(app, a);
    const res = await a.request({
      method: 'PATCH',
      url: `/api/v1/submissions/${submission.id}`,
      payload: body,
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(await rowsFor(app, a)).toEqual(before);
  });

  it('a cancel carrying ids is 422 and cancels nothing', async () => {
    const { app, a } = await boot(ON);
    const { submission } = await draft(app, a);
    const res = await a.request({
      method: 'POST',
      url: `/api/v1/submissions/${submission.id}/cancel`,
      payload: { ids: [submission.id] },
    });
    expect(res.statusCode).toBe(422);
    expect((await rowsFor(app, a))[0]!.status).toBe('draft');
  });
});

describe('the 422 body', () => {
  it('lists every issue, not only the first (qa on #124)', async () => {
    const { app, a } = await boot(ON);
    const res = await create(a, await seedOpportunity(app, a), {
      idempotencyKey: 'not-a-uuid',
      resumeId: ['a', 'b'],
    });
    expect(res.statusCode).toBe(422);
    const paths = (res.json().error.issues as { path: string[] }[]).map((i) => i.path.join('.'));
    expect(paths).toEqual(expect.arrayContaining(['body.idempotencyKey', 'body.resumeId']));
  });
});

describe('editing and cancelling a draft', () => {
  it('saves fields, answers and a new resume, and reads them back', async () => {
    const { app, a } = await boot(ON);
    const { submission } = await draft(app, a);
    const other = await seedResume(app, a);
    const patch = {
      resumeId: other,
      fields: { email: 'candidate@example.com', phone: '555-0100' },
      answers: [
        {
          questionKey: 'why',
          label: 'Why Example Corp?',
          value: 'Placeholder answer.',
          source: 'user',
        },
      ],
    };
    const res = await a.request({
      method: 'PATCH',
      url: `/api/v1/submissions/${submission.id}`,
      payload: patch,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'draft', ...patch });
    const read = await a.request({ method: 'GET', url: `/api/v1/submissions/${submission.id}` });
    expect(read.json()).toMatchObject({ status: 'draft', ...patch });
  });

  it('a resume that is not final is refused on edit too', async () => {
    const { app, a } = await boot(ON);
    const { submission, resumeId } = await draft(app, a);
    const res = await a.request({
      method: 'PATCH',
      url: `/api/v1/submissions/${submission.id}`,
      payload: { resumeId: await seedResume(app, a, 'draft') },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('resume_not_final');
    expect((await rowsFor(app, a))[0]!.resumeId).toBe(resumeId);
  });

  it('only a draft or a reviewed attempt can be edited: anything else is 409 with its status, unchanged', async () => {
    // Since M1c (https://github.com/bgoleno/opportun/issues/116) an edit after review is allowed
    // and sends the attempt back to draft (test/submissionReview.test.ts); later states are not.
    const { app, a } = await boot(ON);
    const { submission } = await draft(app, a);
    for (const status of ['handed_off', 'submitted', 'abandoned'] as const) {
      await app.db
        .update(applicationSubmissions)
        .set({ status })
        .where(eq(applicationSubmissions.id, submission.id))
        .run();
      const before = await rowsFor(app, a);
      const res = await a.request({
        method: 'PATCH',
        url: `/api/v1/submissions/${submission.id}`,
        payload: { fields: { email: 'x@example.com' } },
      });
      expect(res.statusCode, status).toBe(409);
      expect(res.json().error).toMatchObject({ code: 'invalid_transition', from: status });
      expect(await rowsFor(app, a)).toEqual(before);
    }
  });

  it('cancel abandons a draft as cancelled by the user; repeating it changes nothing', async () => {
    const { app, a } = await boot(ON);
    const { submission } = await draft(app, a);
    const url = `/api/v1/submissions/${submission.id}/cancel`;
    const first = await a.request({ method: 'POST', url });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: 'abandoned', failureReason: 'cancelled_by_user' });
    const again = await a.request({ method: 'POST', url });
    expect(again.statusCode).toBe(200);
    expect(again.json().updatedAt).toBe(first.json().updatedAt);
  });

  it.each(['submitted', 'confirmed', 'rejected', 'failed', 'unknown'] as const)(
    'a %s attempt cannot be cancelled: 409, unchanged',
    async (status) => {
      const { app, a } = await boot(ON);
      const { submission } = await draft(app, a);
      await app.db
        .update(applicationSubmissions)
        .set({ status })
        .where(eq(applicationSubmissions.id, submission.id))
        .run();
      const res = await a.request({
        method: 'POST',
        url: `/api/v1/submissions/${submission.id}/cancel`,
      });
      expect(res.statusCode).toBe(409);
      expect((await rowsFor(app, a))[0]!.status).toBe(status);
    },
  );

  it('lists one opportunity’s attempts, newest first, and only that opportunity’s', async () => {
    const { app, a } = await boot(ON);
    const { oppId, resumeId, submission } = await draft(app, a);
    await a.request({ method: 'POST', url: `/api/v1/submissions/${submission.id}/cancel` });
    const second = await create(a, oppId, { idempotencyKey: crypto.randomUUID(), resumeId });
    await draft(app, a); // another opportunity's attempt
    const list = await a.request({
      method: 'GET',
      url: `/api/v1/opportunities/${oppId}/submissions`,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe(2);
    expect(list.json().items.map((s: { id: string }) => s.id)).toEqual([
      second.json().id,
      submission.id,
    ]);
  });
});

describe('AC4: another user’s submission is 404', () => {
  const viaApi = async (c: TestClient, app: FastifyInstance): Promise<string> =>
    (await draft(app, c)).submission.id;
  assertIsolated({
    name: 'submissions (GET)',
    config: ON,
    create: viaApi,
    read: (c, id) => c.request({ method: 'GET', url: `/api/v1/submissions/${id}` }),
  });
  assertIsolated({
    name: 'submissions (PATCH)',
    config: ON,
    create: viaApi,
    read: (c, id) =>
      c.request({ method: 'PATCH', url: `/api/v1/submissions/${id}`, payload: { fields: {} } }),
  });
  assertIsolated({
    name: 'submissions (cancel)',
    config: ON,
    create: viaApi,
    read: (c, id) => c.request({ method: 'POST', url: `/api/v1/submissions/${id}/cancel` }),
  });
  assertIsolated({
    name: 'an opportunity’s submission list',
    config: ON,
    create: async (c, app) => (await draft(app, c)).oppId,
    read: (c, id) => c.request({ method: 'GET', url: `/api/v1/opportunities/${id}/submissions` }),
  });
  assertIsolated({
    name: 'creating a submission on another user’s opportunity',
    config: ON,
    create: async (c, app) => seedOpportunity(app, c),
    read: async (c, id, app) =>
      create(c, id, { idempotencyKey: crypto.randomUUID(), resumeId: await seedResume(app, c) }),
  });
});

describe('AC5: with the flag off, or on the demo, every route is 404', () => {
  async function everyRoute(app: FastifyInstance, c: TestClient, oppId: string, id: string) {
    const resumeId = await seedResume(app, c);
    return await Promise.all([
      create(c, oppId, { idempotencyKey: crypto.randomUUID(), resumeId }),
      c.request({ method: 'GET', url: `/api/v1/opportunities/${oppId}/submissions` }),
      c.request({ method: 'GET', url: `/api/v1/submissions/${id}` }),
      c.request({ method: 'PATCH', url: `/api/v1/submissions/${id}`, payload: { fields: {} } }),
      c.request({ method: 'POST', url: `/api/v1/submissions/${id}/cancel` }),
    ]);
  }

  it.each([
    ['the flag unset', {}],
    ['the flag off', { submissions: false }],
    ['the demo, flag on', { submissions: true, demo: true }],
  ])('with %s', async (_n, config) => {
    const { app, a } = await boot(config);
    const oppId = await seedOpportunity(app, a);
    // A row that exists, so a 404 is the gate's and not a missing id's.
    const resumeId = await seedResume(app, a);
    const id = newId();
    const opp = await app.db.select().from(opportunities).where(eq(opportunities.id, oppId)).get();
    await app.db
      .insert(applicationSubmissions)
      .values({
        id,
        userId: a.userId,
        opportunityId: oppId,
        resumeId,
        atsKind: 'ats_greenhouse',
        atsRef: 'examplecorp',
        atsExternalId: '1000001',
        destinationUrl: (opp!.atsJobRef as AtsJobRef).url,
        status: 'draft',
        idempotencyKey: crypto.randomUUID(),
        fields: {},
        answers: [],
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    const before = await rowsFor(app, a);
    for (const res of await everyRoute(app, a, oppId, id)) {
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json().error.code).toBe('feature_unavailable');
    }
    expect(await rowsFor(app, a)).toEqual(before);
  });
});

// tl review of #124 (blocking 1): merging two opportunities deletes the merged one, and its
// submissions would cascade with it. They move to the kept opportunity instead; when both have a
// live attempt the merge is refused and nothing changes. The merge route is not behind the flag,
// so this holds with the flag off too.
describe('merging opportunities keeps their submissions', () => {
  const merge = (c: TestClient, keepId: string, otherId: string) =>
    c.request({
      method: 'POST',
      url: `/api/v1/opportunities/${keepId}/merge`,
      payload: { otherId },
    });

  async function allSubmissions(app: FastifyInstance) {
    return await app.db.select().from(applicationSubmissions).all();
  }

  it('moves the merged opportunity’s attempts, answers and history included, to the kept one', async () => {
    const { app, a } = await boot(ON);
    const keepId = await seedOpportunity(app, a);
    const { oppId: otherId, resumeId, submission } = await draft(app, a);
    // History beside the live draft: an earlier attempt the user cancelled.
    await a.request({ method: 'POST', url: `/api/v1/submissions/${submission.id}/cancel` });
    const live = await create(a, otherId, { idempotencyKey: crypto.randomUUID(), resumeId });
    const answers = [
      {
        questionKey: 'why',
        label: 'Why Example Corp?',
        value: 'Placeholder answer.',
        source: 'user',
      },
    ];
    await a.request({
      method: 'PATCH',
      url: `/api/v1/submissions/${live.json().id}`,
      payload: { answers },
    });
    const before = await allSubmissions(app);
    expect(before).toHaveLength(2);

    const res = await merge(a, keepId, otherId);
    expect(res.statusCode, res.body).toBe(200);

    const after = await allSubmissions(app);
    expect(after).toHaveLength(2);
    // Every row is the same row, now on the kept opportunity; nothing else about it changed.
    expect(
      after.map((r) => ({ ...r, opportunityId: otherId })).sort((x, y) => x.id.localeCompare(y.id)),
    ).toEqual([...before].sort((x, y) => x.id.localeCompare(y.id)));
    expect(new Set(after.map((r) => r.opportunityId))).toEqual(new Set([keepId]));
    expect(after.find((r) => r.id === live.json().id)!.answers).toEqual(answers);
    const list = await a.request({
      method: 'GET',
      url: `/api/v1/opportunities/${keepId}/submissions`,
    });
    expect(list.json().total).toBe(2);
    // The merge note says so.
    const notes = await a.request({
      method: 'GET',
      url: `/api/v1/opportunities/${keepId}/activities`,
    });
    expect(JSON.stringify(notes.json())).toContain('2 application attempts moved here.');
  });

  it('when both opportunities have a live attempt, the merge is refused and nothing changes', async () => {
    const { app, a } = await boot(ON);
    const kept = await draft(app, a);
    const other = await draft(app, a);
    const before = await allSubmissions(app);
    const oppsBefore = await app.db
      .select()
      .from(opportunities)
      .where(eq(opportunities.userId, a.userId))
      .all();

    const res = await merge(a, kept.oppId, other.oppId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'live_submission_conflict',
      submissionId: other.submission.id,
    });
    expect(await allSubmissions(app)).toEqual(before);
    expect(
      await app.db.select().from(opportunities).where(eq(opportunities.userId, a.userId)).all(),
    ).toEqual(oppsBefore);

    // Cancel one, and the merge goes through, both attempts kept.
    await a.request({ method: 'POST', url: `/api/v1/submissions/${other.submission.id}/cancel` });
    expect((await merge(a, kept.oppId, other.oppId)).statusCode).toBe(200);
    const after = await allSubmissions(app);
    expect(after).toHaveLength(2);
    expect(new Set(after.map((r) => r.opportunityId))).toEqual(new Set([kept.oppId]));
  });

  it('with the flag off, a merge still keeps the attempts (the merge route is not flagged)', async () => {
    const { app, a } = await boot({});
    const keepId = await seedOpportunity(app, a);
    const otherId = await seedOpportunity(app, a);
    const id = newId();
    await app.db
      .insert(applicationSubmissions)
      .values({
        id,
        userId: a.userId,
        opportunityId: otherId,
        resumeId: null,
        atsKind: 'ats_greenhouse',
        atsRef: 'examplecorp',
        atsExternalId: '1000001',
        destinationUrl: ATS_REF.url,
        status: 'abandoned',
        idempotencyKey: crypto.randomUUID(),
        fields: {},
        answers: [],
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    expect((await merge(a, keepId, otherId)).statusCode).toBe(200);
    const after = await allSubmissions(app);
    expect(after.map((r) => [r.id, r.opportunityId])).toEqual([[id, keepId]]);
  });
});

// tl review of #124 (optional): two creates that both pass the repo's checks race on insert,
// and the unique indexes decide. Held at the race point so both have done their reads.
describe('concurrent creates', () => {
  it('the same key twice: one draft, the other a replay of it', async () => {
    const { app, a } = await boot(ON);
    const oppId = await seedOpportunity(app, a);
    const body = { idempotencyKey: crypto.randomUUID(), resumeId: await seedResume(app, a) };
    const barrier = holdAt('submissions.create', 2);
    const [x, y] = await Promise.all([
      createSubmissionDraft(app.db, ctxOf(a), oppId, body),
      createSubmissionDraft(app.db, ctxOf(a), oppId, body),
    ]);
    expect(barrier.arrived()).toBe(2);
    expect(x.submission.id).toBe(y.submission.id);
    expect([x.replayed, y.replayed].sort()).toEqual([false, true]);
    expect(await rowsFor(app, a)).toHaveLength(1);
  });

  it('two keys for one opportunity: one draft, the other 409 naming it', async () => {
    const { app, a } = await boot(ON);
    const oppId = await seedOpportunity(app, a);
    const resumeId = await seedResume(app, a);
    const barrier = holdAt('submissions.create', 2);
    const results = await Promise.allSettled([
      createSubmissionDraft(app.db, ctxOf(a), oppId, {
        idempotencyKey: crypto.randomUUID(),
        resumeId,
      }),
      createSubmissionDraft(app.db, ctxOf(a), oppId, {
        idempotencyKey: crypto.randomUUID(),
        resumeId,
      }),
    ]);
    expect(barrier.arrived()).toBe(2);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toMatchObject({ statusCode: 409, code: 'live_submission_exists' });
    expect(await rowsFor(app, a)).toHaveLength(1);
  });
});

// qa's blocker on #124 (seen on Postgres; SQLite's serialised writes never exercised it): a
// create can pass the key check before another request with the same key inserts its draft, and
// then find that draft in the live check. It is the request's own draft: a replay, not a 409.
// Forced deterministically here, so it runs on both engines: B is held right after its key check
// while A creates the draft, then B continues.
describe('a same-key create that checked the key before the draft existed', () => {
  it('replays the draft its key created instead of refusing it', async () => {
    const { app, a } = await boot(ON);
    const oppId = await seedOpportunity(app, a);
    const body = { idempotencyKey: crypto.randomUUID(), resumeId: await seedResume(app, a) };
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let arrived!: () => void;
    const bAtPoint = new Promise<void>((r) => (arrived = r));
    let first = true;
    setRaceHook(async (point) => {
      if (point !== 'submissions.create.keyChecked' || !first) return;
      first = false;
      arrived();
      await held;
    });
    const b = createSubmissionDraft(app.db, ctxOf(a), oppId, body);
    await bAtPoint;
    const aResult = await createSubmissionDraft(app.db, ctxOf(a), oppId, body);
    release();
    const bResult = await b;
    expect(aResult.replayed).toBe(false);
    expect(bResult).toEqual({ submission: aResult.submission, replayed: true });
    expect(await rowsFor(app, a)).toHaveLength(1);
  });
});

describe('the destination at creation (#135)', () => {
  // The handoff opens only a recognised ATS posting for this requisition (destinationAllowed,
  // repos/submissionReview.ts). A draft whose destination could never pass it is refused at the
  // start, before the user fills it in and spends a review on it.
  it.each([
    [
      'a career page carrying the posting id',
      { ...ATS_REF, org: null, url: 'https://careers.example.com/open-roles?gh_jid=1000001' },
    ],
    ['a LinkedIn job page', { ...ATS_REF, url: 'https://www.linkedin.com/jobs/view/1000001' }],
    [
      'a lookalike ATS host',
      { ...ATS_REF, url: 'https://boards.greenhouse.io.example.com/examplecorp/jobs/1000001' },
    ],
    [
      'another company’s board',
      { ...ATS_REF, url: 'https://boards.greenhouse.io/othercorp/jobs/1000001' },
    ],
    [
      'another requisition',
      { ...ATS_REF, url: 'https://boards.greenhouse.io/examplecorp/jobs/1000002' },
    ],
    [
      'credentials in the URL',
      { ...ATS_REF, url: 'https://jane@boards.greenhouse.io/examplecorp/jobs/1000001' },
    ],
  ])(
    'an opportunity whose destination is %s gets 422 destination_not_allowed, and nothing is stored',
    async (_n, ats) => {
      const { app, a } = await boot(ON);
      const oppId = await seedOpportunity(app, a, { ats });
      const res = await create(a, oppId, {
        idempotencyKey: crypto.randomUUID(),
        resumeId: await seedResume(app, a),
      });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().error.code).toBe('destination_not_allowed');
      expect(await rowsFor(app, a)).toEqual([]);
      // No audit entry and no snapshot job either: the refusal changes nothing.
      const audited = await app.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.userId, a.userId), like(auditLog.event, 'submission.%')))
        .all();
      expect(audited).toEqual([]);
      expect(await app.db.select().from(jobs).where(like(jobs.kind, 'submission.%')).all()).toEqual(
        [],
      );
    },
  );

  it.each([
    ['a Greenhouse board posting', ATS_REF],
    [
      'a Greenhouse posting with tracking parameters',
      { ...ATS_REF, url: `${ATS_REF.url}?gh_src=abc&utm_source=x` },
    ],
    [
      'a Workday posting on its own tenant',
      {
        kind: 'ats_workday',
        org: 'acme/External',
        externalId: 'JR-000001',
        url: 'https://acme.wd1.myworkdayjobs.com/en-US/External/job/X/Engineer_JR-000001',
      } satisfies AtsJobRef,
    ],
  ])('an opportunity whose destination is %s is created as before', async (_n, ats) => {
    const { app, a } = await boot(ON);
    const res = await create(a, await seedOpportunity(app, a, { ats }), {
      idempotencyKey: crypto.randomUUID(),
      resumeId: await seedResume(app, a),
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().destinationUrl).toBe(ats.url);
  });
});
