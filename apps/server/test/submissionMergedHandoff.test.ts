// An application opened on the employer's site whose opportunity is merged away
// (https://github.com/bgoleno/opportun/issues/1057; tl's design with sec's conditions, there): the
// review digest covers the opportunity, so the extension no longer fills it. The answers say that it
// was the merge, and the user can review it again. No digest is stored that a screen did not echo.
// Every attempt is made through the real session routes; tokens are minted through POST /device-tokens.
import { newId, type AtsJobRef } from '@opportun/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { onSlowTransaction } from '../src/db/gate';
import { applicationSubmissions, attachments, auditLog, opportunities } from '../src/db/schema';
import { createOpportunity, mergeOpportunities } from '../src/repos/opportunities';
import { HANDOFF_IDLE_MS, sweepSubmissions } from '../src/repos/submissionReview';
import { useApi } from './api';
import type { TestClient } from './isolation';
import { testDialect } from './db';
import { heldApart, pauseAt, whileParked } from './race';
import { api, handedOffAttempt, requisition, submittedAttempt } from './submissionFixtures';

const boot = useApi();
const ON = { submissions: true };
const PASSWORD = 'correct horse battery';
const FIELDS = { email: 'jane@example.com' };
const PDF = Buffer.from('%PDF-1.4\n% placeholder resume snapshot\n%%EOF\n');
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

type Json = Record<string, unknown>;

async function setup() {
  const { app, a, b } = await boot(ON);
  const { db } = app;
  const minted = await a.request({
    method: 'POST',
    url: '/api/v1/device-tokens',
    payload: { name: 'Chrome', scopes: ['apply:assist'], password: PASSWORD },
  });
  expect(minted.statusCode, minted.body).toBe(201);
  const headers = { authorization: `Bearer ${minted.json<{ token: string }>().token}` };
  const device = (url: string) =>
    app.inject({ method: 'GET', url: `/api/v1/connector/apply${url}`, headers });
  const current = async (ats: AtsJobRef) =>
    (await device(`/current?url=${encodeURIComponent(ats.url)}`)).json<{
      attempt: Json | null;
      reason: string | null;
      cause?: string;
    }>();
  const rowOf = async (id: string) =>
    (await db
      .select()
      .from(applicationSubmissions)
      .where(eq(applicationSubmissions.id, id))
      .get())!;
  const viewOf = async (id: string) =>
    (await api(a, 'GET', `/submissions/${id}`)).json<
      Json & { reviewDigest: string; mergedAt: number | null; reviewLapsed: boolean }
    >();
  /** The kept one, at `ref`. */
  const kept = async (ref: AtsJobRef | null): Promise<string> => {
    const { id } = await createOpportunity(db, ctxOf(a), {
      companyName: 'Example Corp',
      title: `Senior Platform Engineer ${newId()}`,
      sourceKind: 'manual',
    });
    await db
      .update(opportunities)
      .set({ atsJobRef: ref, postingUrl: ref?.url ?? null, stage: 'interested' })
      .where(eq(opportunities.id, id))
      .run();
    return id;
  };
  const merge = async (s: { oppId: string; ats: AtsJobRef }): Promise<string> => {
    const keepId = await kept(s.ats);
    const res = await api(a, 'POST', `/opportunities/${keepId}/merge`, { otherId: s.oppId });
    expect(res.statusCode, res.body).toBe(200);
    return keepId;
  };
  const review = async (id: string, reviewDigest?: string) =>
    api(a, 'POST', `/submissions/${id}/review`, {
      reviewDigest: reviewDigest ?? (await viewOf(id)).reviewDigest,
      acknowledged: true,
    });
  const handoff = (id: string) => api(a, 'POST', `/submissions/${id}/handoff`, {});
  const again = (id: string, c: TestClient = a) =>
    api(c, 'POST', `/submissions/${id}/review-again`, {});
  const audited = async (event: string) =>
    (await db.select().from(auditLog).where(eq(auditLog.event, event)).all()).map((r) => r.detail);
  /** The snapshot as its job leaves it for an exported PDF. */
  const withFile = async (id: string): Promise<void> => {
    const stored = await app.storage.writeAttachment(PDF);
    const attachmentId = newId();
    await db
      .insert(attachments)
      .values({
        id: attachmentId,
        userId: a.userId,
        opportunityId: null,
        filename: 'Example Resume.pdf',
        mime: 'application/pdf',
        bytes: stored.bytes,
        sha256: stored.sha256,
        storedPath: stored.storedPath,
        createdAt: Date.now(),
      })
      .run();
    await db
      .update(applicationSubmissions)
      .set({ snapshotState: 'ready', resumeAttachmentId: attachmentId })
      .where(eq(applicationSubmissions.id, id))
      .run();
  };
  const handedOff = () =>
    handedOffAttempt(app, a, { fields: FIELDS, title: `Platform Engineer ${newId()}` });
  /** Handed off, and then its opportunity merged away. */
  const lapsed = async () => {
    const s = await handedOff();
    const keepId = await merge(s);
    return { ...s, keepId };
  };
  return {
    app,
    db,
    a,
    b,
    headers,
    device,
    current,
    rowOf,
    viewOf,
    kept,
    merge,
    review,
    handoff,
    again,
    audited,
    withFile,
    handedOff,
    lapsed,
  };
}

describe('what a merge records of the application it moves (#1057)', () => {
  it.each(['draft', 'reviewed', undefined] as const)(
    'when it moved: %s (handed off)',
    async (stopAt) => {
      const s = await setup();
      const d = await handedOffAttempt(s.app, s.a, stopAt === undefined ? {} : { stopAt });
      const bystander = await s.handedOff();
      const before = Date.now();
      expect(await s.viewOf(d.id)).toMatchObject({ mergedAt: null, reviewLapsed: false });
      await s.merge(d);
      const view = await s.viewOf(d.id);
      expect(view.mergedAt).toBeGreaterThanOrEqual(before);
      expect(view.reviewLapsed).toBe(stopAt === undefined);
      expect((await s.rowOf(bystander.id)).mergedAt).toBeNull();
    },
  );

  it('nothing of one that is not live, or that stays where it is', async () => {
    const s = await setup();
    const sent = await submittedAttempt(s.app, s.a);
    const own = await s.handedOff();
    await s.merge(sent);
    const other = await s.kept(null);
    await mergeOpportunities(s.db, ctxOf(s.a), own.oppId, other);
    expect((await s.rowOf(sent.id)).mergedAt).toBeNull();
    expect((await s.rowOf(own.id)).mergedAt).toBeNull();
    expect(await s.viewOf(own.id)).toMatchObject({ mergedAt: null, reviewLapsed: false });
  });

  it('one handed off has nothing else of it changed', async () => {
    const s = await setup();
    const d = await s.handedOff();
    const before = await s.rowOf(d.id);
    const keepId = await s.merge(d);
    const row = await s.rowOf(d.id);
    expect(row).toEqual({ ...before, opportunityId: keepId, mergedAt: row.mergedAt });
  });
});

describe('what the extension is told of it (#1057)', () => {
  it('the form: not filled, as before, and that it was a merge; the first read is not spent', async () => {
    const s = await setup();
    const d = await s.lapsed();
    expect(await s.current(d.ats)).toEqual({
      attempt: null,
      reason: 'review_stale',
      cause: 'merged',
    });
    expect((await s.rowOf(d.id)).prefillReadAt).toBeNull();
    expect((await s.audited('submission.prefill_read')).at(-1)).toMatchObject({
      submissionId: null,
      reason: 'review_stale',
    });
  });

  it('the resume: refused, as before, and the same', async () => {
    const s = await setup();
    const d = await s.handedOff();
    await s.withFile(d.id);
    expect((await s.device(`/${d.id}/snapshot`)).statusCode).toBe(200);
    await s.merge(d);
    const res = await s.device(`/${d.id}/snapshot`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: {
        code: 'review_stale',
        message: 'This application changed after it was reviewed.',
        cause: 'merged',
      },
    });
  });

  it('stale for another cause: no cause', async () => {
    const s = await setup();
    const d = await s.handedOff();
    await s.withFile(d.id);
    await s.db
      .update(applicationSubmissions)
      .set({ fields: { email: 'changed@example.com' } })
      .where(eq(applicationSubmissions.id, d.id))
      .run();
    expect(await s.current(d.ats)).toEqual({ attempt: null, reason: 'review_stale' });
    expect((await s.device(`/${d.id}/snapshot`)).json<{ error: Json }>().error).not.toHaveProperty(
      'cause',
    );
    expect(await s.viewOf(d.id)).toMatchObject({ mergedAt: null, reviewLapsed: true });
  });

  it('merged, reviewed and opened again, and stale later for another cause: no cause', async () => {
    const s = await setup();
    const d = await s.lapsed();
    expect((await s.again(d.id)).statusCode).toBe(200);
    expect((await s.review(d.id)).statusCode).toBe(200);
    expect((await s.handoff(d.id)).statusCode).toBe(200);
    expect((await s.current(d.ats)).attempt).toMatchObject({ id: d.id, firstRead: true });
    await s.db
      .update(applicationSubmissions)
      .set({ fields: { email: 'changed@example.com' } })
      .where(eq(applicationSubmissions.id, d.id))
      .run();
    expect(await s.current(d.ats)).toEqual({ attempt: null, reason: 'review_stale' });
  });

  it('nothing for a page no application is of, nor for several', async () => {
    const s = await setup();
    const d = await s.lapsed();
    expect(await s.current(requisition())).toEqual({
      attempt: null,
      reason: 'no_matching_attempt',
    });
    const second = await s.handedOff();
    await s.db
      .update(applicationSubmissions)
      .set({ atsRef: d.ats.org, atsExternalId: d.ats.externalId })
      .where(eq(applicationSubmissions.id, second.id))
      .run();
    expect(await s.current(d.ats)).toEqual({ attempt: null, reason: 'several_handed_off' });
  });
});

describe('what it may still do without a review (#1057)', () => {
  it('"I submitted it" is recorded, on the kept one', async () => {
    const s = await setup();
    const d = await s.lapsed();
    const res = await api(s.a, 'POST', `/submissions/${d.id}/attest`, { moveToApplied: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'submitted',
      opportunityId: d.keepId,
      reviewLapsed: false,
    });
  });

  it('it can be cancelled', async () => {
    const s = await setup();
    const d = await s.lapsed();
    const res = await api(s.a, 'POST', `/submissions/${d.id}/cancel`, {});
    expect(res.json()).toMatchObject({ status: 'abandoned', reviewLapsed: false });
  });
});

describe('POST /submissions/:id/review-again (#1057)', () => {
  it('a draft again, with what the user wrote; nothing of the review is left to hand off', async () => {
    const s = await setup();
    const d = await s.lapsed();
    await s.db
      .update(applicationSubmissions)
      .set({ prefillReadAt: 5 })
      .where(eq(applicationSubmissions.id, d.id))
      .run();
    const before = await s.rowOf(d.id);
    const res = await s.again(d.id);
    expect(res.statusCode, res.body).toBe(200);
    const row = await s.rowOf(d.id);
    // That it was opened once is kept (sec): it may have been sent.
    expect(before.handedOffAt).not.toBeNull();
    expect(row).toEqual({
      ...before,
      status: 'draft',
      reviewDigest: null,
      reviewExpiresAt: null,
      prefillReadAt: null,
      updatedAt: row.updatedAt,
    });
    expect(res.json()).toMatchObject({
      id: d.id,
      opportunityId: d.keepId,
      status: 'draft',
      handedOffAt: before.handedOffAt,
      mergedAt: before.mergedAt,
      reviewLapsed: false,
      fields: FIELDS,
    });
    expect(await s.audited('submission.review_lapsed')).toEqual([
      { submissionId: d.id, opportunityId: d.keepId, from: 'handed_off' },
    ]);
    expect((await s.handoff(d.id)).statusCode).toBe(409);
    expect(await s.current(d.ats)).toEqual({ attempt: null, reason: 'no_matching_attempt' });
  });

  it('then it is reviewed, opened and filled as any other; one place under the daily cap', async () => {
    const s = await setup();
    const d = await s.lapsed();
    const old = (await s.rowOf(d.id)).reviewDigest!;
    const first = (await s.rowOf(d.id)).handedOffAt!;
    expect((await s.again(d.id)).statusCode).toBe(200);
    const stale = await s.review(d.id, old);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'review_stale' } });
    const shown = (await s.viewOf(d.id)).reviewDigest;
    expect((await s.review(d.id, shown)).statusCode).toBe(200);
    // What was echoed, and nothing else, is stored.
    expect((await s.rowOf(d.id)).reviewDigest).toBe(shown);
    expect((await s.handoff(d.id)).statusCode).toBe(200);
    expect((await s.rowOf(d.id)).handedOffAt).toBeGreaterThanOrEqual(first);
    expect(await s.viewOf(d.id)).toMatchObject({ status: 'handed_off', reviewLapsed: false });
    expect((await s.current(d.ats)).attempt).toMatchObject({
      id: d.id,
      opportunityId: d.keepId,
      fields: FIELDS,
      firstRead: true,
    });
    const used = await api(s.a, 'GET', '/settings/applications');
    expect(used.json<{ used: number }>().used).toBe(1);
  });

  it('one whose digest changed for another cause, too', async () => {
    const s = await setup();
    const d = await s.handedOff();
    await s.db
      .update(applicationSubmissions)
      .set({ reviewDigest: 'f'.repeat(64) })
      .where(eq(applicationSubmissions.id, d.id))
      .run();
    expect((await s.again(d.id)).json()).toMatchObject({ status: 'draft', mergedAt: null });
  });

  it('one with no digest at all is lapsed', async () => {
    const s = await setup();
    const d = await s.handedOff();
    await s.db
      .update(applicationSubmissions)
      .set({ reviewDigest: null })
      .where(eq(applicationSubmissions.id, d.id))
      .run();
    expect((await s.viewOf(d.id)).reviewLapsed).toBe(true);
    expect((await s.again(d.id)).statusCode).toBe(200);
  });

  it.each([
    'draft',
    'reviewed',
    'submitted',
    'abandoned',
    'handed off, its review holding',
  ] as const)('refused for one that is %s; nothing is written', async (state) => {
    const s = await setup();
    const d =
      state === 'draft' || state === 'reviewed'
        ? await handedOffAttempt(s.app, s.a, { stopAt: state })
        : state === 'submitted'
          ? await submittedAttempt(s.app, s.a)
          : await s.handedOff();
    if (state === 'abandoned') await api(s.a, 'POST', `/submissions/${d.id}/cancel`, {});
    const before = await s.rowOf(d.id);
    const res = await s.again(d.id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({
      error: { code: 'invalid_transition', submissionId: d.id, from: before.status, to: 'draft' },
    });
    expect(await s.rowOf(d.id)).toEqual(before);
    expect(await s.audited('submission.review_lapsed')).toEqual([]);
  });

  it('another user’s is not there; nor is the route for a device, or with assisted apply off', async () => {
    const s = await setup();
    const d = await s.lapsed();
    const before = await s.rowOf(d.id);
    expect((await s.again(d.id, s.b)).statusCode).toBe(404);
    const byDevice = await s.app.inject({
      method: 'POST',
      url: `/api/v1/submissions/${d.id}/review-again`,
      headers: s.headers,
      payload: {},
    });
    expect(byDevice.statusCode).toBe(403);
    expect(
      (await api(s.a, 'POST', `/submissions/${d.id}/review-again`, { status: 'x' })).statusCode,
    ).toBe(422);
    (s.app.config as { submissions?: boolean }).submissions = false;
    expect((await s.again(d.id)).statusCode).toBe(404);
    expect(await s.rowOf(d.id)).toEqual(before);
  });

  it('it has review’s rate limit', async () => {
    const s = await setup();
    const d = await s.handedOff();
    const codes: number[] = [];
    // The fixture's own review was the first of the ten.
    for (let i = 0; i < 10; i += 1) codes.push((await s.again(d.id)).statusCode);
    expect(codes).toEqual([...Array<number>(9).fill(409), 429]);
  });

  it('only it makes a draft of one that was opened: an edit is refused, its review holding or not', async () => {
    const s = await setup();
    for (const d of [await s.handedOff(), await s.lapsed()]) {
      const before = await s.rowOf(d.id);
      const res = await api(s.a, 'PATCH', `/submissions/${d.id}`, {
        fields: { email: 'x@example.com' },
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(await s.rowOf(d.id)).toEqual(before);
    }
  });

  it('a draft again, it can not be said to be sent, nor found by its confirmation page', async () => {
    const s = await setup();
    const d = await s.lapsed();
    expect((await s.again(d.id)).statusCode).toBe(200);
    const before = await s.rowOf(d.id);
    const attest = await api(s.a, 'POST', `/submissions/${d.id}/attest`, { moveToApplied: false });
    expect(attest.statusCode).toBe(409);
    const url = `${d.ats.url}/confirmation`;
    expect((await s.device(`/confirmable?url=${encodeURIComponent(url)}`)).json()).toMatchObject({
      attempt: null,
    });
    const page = await s.app.inject({
      method: 'POST',
      url: `/api/v1/connector/apply/${d.id}/confirmation`,
      headers: s.headers,
      payload: { url, title: 'Thank you', text: 'Thank you for applying.' },
    });
    expect(page.statusCode).toBeGreaterThanOrEqual(400);
    expect(await s.rowOf(d.id)).toEqual(before);
  });

  it('opened again, it can not have been submitted before that', async () => {
    const s = await setup();
    const d = await s.lapsed();
    expect((await s.again(d.id)).statusCode).toBe(200);
    expect((await s.review(d.id)).statusCode).toBe(200);
    expect((await s.handoff(d.id)).statusCode).toBe(200);
    const res = await api(s.a, 'POST', `/submissions/${d.id}/attest`, {
      moveToApplied: false,
      submittedAt: Date.now() - 24 * 60 * 60 * 1000,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'submitted_at_before_handoff' } });
  });
});

describe('review-again beside another change of it (#1057)', () => {
  it('pressed twice at once: one draft, one audit row', async () => {
    const s = await setup();
    const d = await s.lapsed();
    const [first, second] = await heldApart(
      s.app,
      'submissions.reviewAgain.locked',
      () => s.again(d.id),
      () => s.again(d.id),
    );
    expect([first.statusCode, second.statusCode]).toEqual([200, 409]);
    expect(await s.audited('submission.review_lapsed')).toHaveLength(1);
    expect((await s.rowOf(d.id)).status).toBe('draft');
  });

  it('"I submitted it" waits for it, and is refused', async () => {
    const s = await setup();
    const d = await s.lapsed();
    const [first, second] = await heldApart(
      s.app,
      'submissions.reviewAgain.locked',
      () => s.again(d.id),
      () => api(s.a, 'POST', `/submissions/${d.id}/attest`, { moveToApplied: false }),
    );
    expect([first.statusCode, second.statusCode]).toEqual([200, 409]);
    expect((await s.rowOf(d.id)).status).toBe('draft');
  });

  it('"I submitted it" first: it waits, and is refused', async () => {
    const s = await setup();
    const d = await s.lapsed();
    const [first, second] = await heldApart(
      s.app,
      'submissions.attest.updated',
      () => api(s.a, 'POST', `/submissions/${d.id}/attest`, { moveToApplied: false }),
      () => s.again(d.id),
    );
    expect([first.statusCode, second.statusCode]).toEqual([200, 409]);
    expect((await s.rowOf(d.id)).status).toBe('submitted');
    expect(await s.audited('submission.review_lapsed')).toEqual([]);
  });

  it('a cancel waits for it, and cancels the draft', async () => {
    const s = await setup();
    const d = await s.lapsed();
    const [first, second] = await heldApart(
      s.app,
      'submissions.reviewAgain.locked',
      () => s.again(d.id),
      () => api(s.a, 'POST', `/submissions/${d.id}/cancel`, {}),
    );
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect((await s.rowOf(d.id)).status).toBe('abandoned');
  });

  it('a second merge waits for it, and moves the draft', async () => {
    const s = await setup();
    const d = await s.lapsed();
    const third = await s.kept(d.ats);
    const [first] = await heldApart(
      s.app,
      'submissions.reviewAgain.locked',
      () => s.again(d.id),
      () => mergeOpportunities(s.db, ctxOf(s.a), third, d.keepId),
    );
    expect(first.statusCode).toBe(200);
    expect(await s.rowOf(d.id)).toMatchObject({ status: 'draft', opportunityId: third });
  });

  it('a second merge first: it waits, and makes a draft of the moved one', async () => {
    const s = await setup();
    const d = await s.lapsed();
    const third = await s.kept(d.ats);
    const [, second] = await heldApart(
      s.app,
      'opportunities.merge.moved',
      () => mergeOpportunities(s.db, ctxOf(s.a), third, d.keepId),
      () => s.again(d.id),
    );
    expect(second.statusCode, second.body).toBe(200);
    expect(await s.rowOf(d.id)).toMatchObject({ status: 'draft', opportunityId: third });
    expect(await s.audited('submission.review_lapsed')).toEqual([
      { submissionId: d.id, opportunityId: third, from: 'handed_off' },
    ]);
  });

  it('a merge of one whose review holds, first: it waits, and the review has lapsed', async () => {
    const s = await setup();
    const d = await s.handedOff();
    const keepId = await s.kept(d.ats);
    const [, second] = await heldApart(
      s.app,
      'opportunities.merge.moved',
      () => mergeOpportunities(s.db, ctxOf(s.a), keepId, d.oppId),
      () => s.again(d.id),
    );
    expect(second.statusCode, second.body).toBe(200);
    expect((await s.rowOf(d.id)).status).toBe('draft');
  });

  // The sweep takes no attempt's lock. SQLite's write gate makes it wait.
  it.runIf(testDialect === 'postgres')(
    'the idle sweep between its read and its write: given up, and it is refused',
    async () => {
      const s = await setup();
      const d = await s.lapsed();
      await s.db
        .update(applicationSubmissions)
        .set({ handedOffAt: Date.now() - HANDOFF_IDLE_MS - 1 })
        .where(eq(applicationSubmissions.id, d.id))
        .run();
      // Parked inside its transaction, on purpose.
      onSlowTransaction(() => undefined);
      const pause = pauseAt('submissions.reviewAgain.locked');
      const pressed = s.again(d.id);
      await whileParked(pause, async () => {
        expect(await sweepSubmissions(s.db)).toBe(1);
      });
      const res = await pressed;
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({
        error: { code: 'invalid_transition', from: 'abandoned' },
      });
      expect((await s.rowOf(d.id)).status).toBe('abandoned');
      expect(await s.audited('submission.review_lapsed')).toEqual([]);
    },
  );

  it('the idle sweep: after it, it is given up, and it is refused; before it, the draft stays', async () => {
    const s = await setup();
    const idle = async (id: string) =>
      await s.db
        .update(applicationSubmissions)
        .set({ handedOffAt: Date.now() - HANDOFF_IDLE_MS - 1 })
        .where(eq(applicationSubmissions.id, id))
        .run();
    const swept = await s.lapsed();
    await idle(swept.id);
    expect(await sweepSubmissions(s.db)).toBe(1);
    expect((await s.again(swept.id)).statusCode).toBe(409);
    expect((await s.rowOf(swept.id)).status).toBe('abandoned');
    const drafted = await s.lapsed();
    await idle(drafted.id);
    expect((await s.again(drafted.id)).statusCode).toBe(200);
    expect(await sweepSubmissions(s.db)).toBe(0);
    expect((await s.rowOf(drafted.id)).status).toBe('draft');
  });
});
