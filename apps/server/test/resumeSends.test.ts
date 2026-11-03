// Resume sends (https://github.com/bgoleno/opportun/issues/158): a resume, base or tailored,
// recorded as sent for an opportunity, without moving or changing the resume. The resume's
// status and submitted fields are derived from its sends and its own stored record.
import { newId } from '@opportun/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { resumes, resumeSends, users } from '../src/db/schema';
import { insertResume, setResumeStatus } from '../src/repos/resumes';
import { useApi } from './api';
import { assertIsolated, type TestClient } from './isolation';
import { heldApart, pauseAt, settledOrWaiting } from './race';
import { testDialect } from './db';
import { onSlowTransaction } from '../src/db/gate';
import { connectGoogle, fakeGoogle } from './fakeGoogle';
import { BASE_DOC_ID, BASE_TEXT, createOpportunity, registerBase } from './resumeFixtures';

const boot = useApi();
const bootGoogle = useApi(() => ({
  build: { google: fakeGoogle({ [BASE_DOC_ID]: { title: 'Jane Base Resume', text: BASE_TEXT } }) },
}));
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

/** A local-file resume of this kind, inserted directly (no document store involved). */
async function resume(
  app: FastifyInstance,
  c: TestClient,
  over: {
    kind?: 'base' | 'tailored';
    parentResumeId?: string | null;
    opportunityId?: string | null;
    /** Final by default: a finished resume, the kind that gets sent. */
    status?: 'draft' | 'in_review' | 'final';
  } = {},
): Promise<string> {
  const row = await insertResume(app.db, ctxOf(c), {
    kind: over.kind ?? 'base',
    title: over.kind === 'tailored' ? 'Tailored copy' : 'Base resume',
    store: 'local_file',
    docRef: `resumes/${newId()}.txt`,
    opportunityId: over.opportunityId ?? null,
    parentResumeId: over.parentResumeId ?? null,
  });
  await setResumeStatus(app.db, ctxOf(c), row.id, over.status ?? 'final');
  return row.id;
}

const resumeRow = async (app: FastifyInstance, id: string) =>
  await app.db.select().from(resumes).where(eq(resumes.id, id)).get();

const record = (c: TestClient, oppId: string, body: Record<string, unknown>) =>
  c.request({ method: 'POST', url: `/api/v1/opportunities/${oppId}/resume-sends`, payload: body });
const listSends = (c: TestClient, oppId: string) =>
  c.request({ method: 'GET', url: `/api/v1/opportunities/${oppId}/resume-sends` });
const removeSend = (c: TestClient, oppId: string, sendId: string) =>
  c.request({ method: 'DELETE', url: `/api/v1/opportunities/${oppId}/resume-sends/${sendId}` });
const getResume = (c: TestClient, id: string) =>
  c.request({ method: 'GET', url: `/api/v1/resumes/${id}` });

describe('recording a base resume as sent (#158 criteria 1, 2, 6)', () => {
  it('records the send and leaves the base row identical, with its tailored copy still linked', async () => {
    const { app, a } = await boot();
    const opp = await createOpportunity(a);
    const base = await resume(app, a);
    const child = await resume(app, a, {
      kind: 'tailored',
      parentResumeId: base,
      opportunityId: opp,
    });
    const before = await resumeRow(app, base);
    const childBefore = await resumeRow(app, child);

    const res = await record(a, opp, {
      resumeId: base,
      sentVia: 'Indeed',
      sentAt: 1_790_000_000_000,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({
      opportunityId: opp,
      resumeId: base,
      resumeKind: 'base',
      resumeTitle: 'Base resume',
      companyName: 'Acme',
      sentVia: 'Indeed',
      sentAt: 1_790_000_000_000,
      submissionId: null,
    });

    // The base row is byte-identical, and its tailored copy keeps both links.
    expect(await resumeRow(app, base)).toEqual(before);
    expect(await resumeRow(app, child)).toEqual(childBefore);
    // Listed for this opportunity, marked as a base.
    const listed = (await listSends(a, opp)).json().items;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ resumeId: base, resumeKind: 'base' });
    // Its summary is derived: submitted, via Indeed, to this opportunity's company.
    expect((await getResume(a, base)).json()).toMatchObject({
      kind: 'base',
      opportunityId: null,
      status: 'submitted',
      submittedAt: 1_790_000_000_000,
      submittedTo: 'Indeed / Acme',
    });
  });

  it('records the same base on a second opportunity, and it can still be tailored from', async () => {
    const { app, a } = await boot();
    const first = await createOpportunity(a, 'First role');
    const second = await createOpportunity(a, 'Second role');
    const base = await resume(app, a);
    const before = await resumeRow(app, base);
    expect(
      (await record(a, first, { resumeId: base, sentVia: 'Indeed', sentAt: 1_000 })).statusCode,
    ).toBe(201);
    expect(
      (await record(a, second, { resumeId: base, sentVia: 'LinkedIn', sentAt: 2_000 })).statusCode,
    ).toBe(201);
    expect(await resumeRow(app, base)).toEqual(before);
    expect((await listSends(a, first)).json().items).toHaveLength(1);
    expect((await listSends(a, second)).json().items).toHaveLength(1);
    // The newest send is the summary.
    expect((await getResume(a, base)).json()).toMatchObject({
      submittedTo: 'LinkedIn / Acme',
      submittedAt: 2_000,
    });
    // The resume page lists both, newest first.
    const onResume = await a.request({ method: 'GET', url: `/api/v1/resumes/${base}/sends` });
    expect(onResume.json().items.map((s: { opportunityId: string }) => s.opportunityId)).toEqual([
      second,
      first,
    ]);
  });

  it('a sent base can still be tailored from: the copy points at it as before', async () => {
    const { a } = await bootGoogle();
    await connectGoogle(a);
    const base = await registerBase(a);
    const opp = await createOpportunity(a);
    expect((await record(a, opp, { resumeId: base, sentVia: 'Indeed' })).statusCode).toBe(201);
    const tailored = await a.request({
      method: 'POST',
      url: '/api/v1/resumes',
      payload: { baseResumeId: base, opportunityId: opp },
    });
    expect(tailored.statusCode, tailored.body).toBe(201);
    expect(tailored.json()).toMatchObject({
      kind: 'tailored',
      parentResumeId: base,
      opportunityId: opp,
    });
  });

  it('attaching a base directly is still refused: a send is a record, not an attachment', async () => {
    const { app, a } = await boot();
    const opp = await createOpportunity(a);
    const base = await resume(app, a);
    const res = await a.request({
      method: 'PATCH',
      url: `/api/v1/resumes/${base}`,
      payload: { opportunityId: opp },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('base_cannot_attach');
  });
});

describe('removing a send (#158 criteria 3, 6)', () => {
  it('removes only that send; the base and its other opportunity are unaffected', async () => {
    const { app, a } = await boot();
    const first = await createOpportunity(a, 'First role');
    const second = await createOpportunity(a, 'Second role');
    const base = await resume(app, a);
    const before = await resumeRow(app, base);
    const one = (
      await record(a, first, { resumeId: base, sentVia: 'Indeed', sentAt: 1_000 })
    ).json();
    await record(a, second, { resumeId: base, sentVia: 'LinkedIn', sentAt: 500 });

    const res = await removeSend(a, first, one.id);
    expect(res.statusCode).toBe(204);
    expect((await listSends(a, first)).json().items).toEqual([]);
    expect((await listSends(a, second)).json().items).toHaveLength(1);
    expect(await resumeRow(app, base)).toEqual(before);
    expect((await getResume(a, base)).json()).toMatchObject({
      submittedTo: 'LinkedIn / Acme',
      submittedAt: 500,
    });
    // A second remove, or a remove through another opportunity, finds nothing.
    expect((await removeSend(a, first, one.id)).statusCode).toBe(404);
  });

  it('a send is removable only through its own opportunity', async () => {
    const { app, a } = await boot();
    const first = await createOpportunity(a, 'First role');
    const second = await createOpportunity(a, 'Second role');
    const base = await resume(app, a);
    const one = (await record(a, first, { resumeId: base, sentVia: 'Indeed' })).json();
    expect((await removeSend(a, second, one.id)).statusCode).toBe(404);
    expect((await listSends(a, first)).json().items).toHaveLength(1);
  });

  it('with its last send removed, the resume reads as its stored record again', async () => {
    const { app, a } = await boot();
    const opp = await createOpportunity(a);
    const base = await resume(app, a);
    const one = (await record(a, opp, { resumeId: base, sentVia: 'Indeed' })).json();
    await removeSend(a, opp, one.id);
    expect((await getResume(a, base)).json()).toMatchObject({
      status: 'final',
      submittedAt: null,
      submittedTo: null,
    });
  });
});

describe('the derived summary (tl on #158)', () => {
  it('is the later of the newest send and a manual "Submitted to" record', async () => {
    const { app, a } = await boot();
    const opp = await createOpportunity(a);
    const id = await resume(app, a, { kind: 'tailored', opportunityId: opp });
    // A manual record first, then a later send: the send shows.
    await a.request({
      method: 'PATCH',
      url: `/api/v1/resumes/${id}`,
      payload: { status: 'submitted', submittedTo: 'Recruiter by email', submittedAt: 1_000 },
    });
    await record(a, opp, { resumeId: id, sentVia: 'Indeed', sentAt: 2_000 });
    expect((await getResume(a, id)).json()).toMatchObject({
      submittedTo: 'Indeed / Acme',
      submittedAt: 2_000,
    });
    // A manual record made after the send shows instead.
    await a.request({
      method: 'PATCH',
      url: `/api/v1/resumes/${id}`,
      payload: { submittedTo: 'Hiring manager', submittedAt: 3_000 },
    });
    expect((await getResume(a, id)).json()).toMatchObject({
      submittedTo: 'Hiring manager',
      submittedAt: 3_000,
    });
  });

  it('is the same on the list as on the single resume, and the company is read at read time', async () => {
    const { app, a } = await boot();
    const opp = await createOpportunity(a);
    const sent = await resume(app, a);
    const unsent = await resume(app, a);
    await record(a, opp, { resumeId: sent, sentVia: 'Indeed', sentAt: 1_000 });
    await a.request({
      method: 'PATCH',
      url: `/api/v1/opportunities/${opp}`,
      payload: { companyName: 'Acme Labs' },
    });
    const list = (await a.request({ method: 'GET', url: '/api/v1/resumes?kind=base' })).json()
      .items as {
      id: string;
      status: string;
      submittedTo: string | null;
    }[];
    expect(list.find((r) => r.id === sent)).toMatchObject({
      status: 'submitted',
      submittedTo: 'Indeed / Acme Labs',
    });
    expect(list.find((r) => r.id === unsent)).toMatchObject({ status: 'final', submittedTo: null });
    expect((await getResume(a, sent)).json()).toMatchObject({ submittedTo: 'Indeed / Acme Labs' });
  });

  it('a draft or in-review resume keeps its status with a send, and still says where it went (tl on #164)', async () => {
    const { app, a } = await boot();
    const opp = await createOpportunity(a);
    const draft = await resume(app, a, { status: 'draft' });
    await record(a, opp, { resumeId: draft, sentVia: 'Indeed', sentAt: 1_000 });
    expect((await getResume(a, draft)).json()).toMatchObject({
      status: 'draft',
      submittedTo: 'Indeed / Acme',
      submittedAt: 1_000,
    });
  });

  it('a sent resume tailored again reads In review; marked final again it reads submitted', async () => {
    const { app, a } = await boot();
    const opp = await createOpportunity(a);
    const id = await resume(app, a);
    await record(a, opp, { resumeId: id, sentVia: 'Indeed', sentAt: 1_000 });
    expect((await getResume(a, id)).json()).toMatchObject({ status: 'submitted' });
    // Tailoring completion moves it to in_review without going through updateResume.
    await setResumeStatus(app.db, ctxOf(a), id, 'in_review');
    expect((await getResume(a, id)).json()).toMatchObject({
      status: 'in_review',
      submittedTo: 'Indeed / Acme',
    });
    // The status stays the user's to set: no refusal for a resume with sends.
    const final = await a.request({
      method: 'PATCH',
      url: `/api/v1/resumes/${id}`,
      payload: { status: 'final' },
    });
    expect(final.statusCode, final.body).toBe(200);
    expect(final.json()).toMatchObject({ status: 'submitted', submittedTo: 'Indeed / Acme' });
  });
});

describe('what a send refuses', () => {
  it('a time in the future, an empty "via", and an archived resume', async () => {
    const { app, a } = await boot();
    const opp = await createOpportunity(a);
    const id = await resume(app, a);
    const future = await record(a, opp, {
      resumeId: id,
      sentVia: 'Indeed',
      sentAt: Date.now() + 3_600_000,
    });
    expect(future.statusCode).toBe(422);
    expect(future.json().error.code).toBe('sent_at_in_future');
    expect((await record(a, opp, { resumeId: id, sentVia: '   ' })).statusCode).toBe(400);
    await app.db.update(resumes).set({ archivedAt: Date.now() }).where(eq(resumes.id, id)).run();
    const archived = await record(a, opp, { resumeId: id, sentVia: 'Indeed' });
    expect(archived.statusCode).toBe(422);
    expect(archived.json().error.code).toBe('resume_archived');
    expect(await app.db.select().from(resumeSends).all()).toEqual([]);
  });

  it("another user's resume or opportunity is a 404, and records nothing", async () => {
    const { app, a, b } = await boot();
    const mine = await createOpportunity(a);
    const theirs = await createOpportunity(b);
    const myResume = await resume(app, a);
    const theirResume = await resume(app, b);
    expect((await record(a, mine, { resumeId: theirResume, sentVia: 'Indeed' })).statusCode).toBe(
      404,
    );
    expect((await record(a, theirs, { resumeId: myResume, sentVia: 'Indeed' })).statusCode).toBe(
      404,
    );
    expect(await app.db.select().from(resumeSends).all()).toEqual([]);
  });
});

describe('deleting what a send names', () => {
  it('deleting a resume with a send archives it, and the send survives', async () => {
    const { app, a } = await boot();
    const opp = await createOpportunity(a);
    const id = await resume(app, a);
    await record(a, opp, { resumeId: id, sentVia: 'Indeed' });
    const res = await a.request({ method: 'DELETE', url: `/api/v1/resumes/${id}` });
    expect(res.json()).toMatchObject({ outcome: 'archived' });
    expect((await listSends(a, opp)).json().items).toHaveLength(1);
  });

  it('deleting the opportunity removes its sends and leaves the resume', async () => {
    const { app, a } = await boot();
    const opp = await createOpportunity(a);
    const id = await resume(app, a);
    const before = await resumeRow(app, id);
    await record(a, opp, { resumeId: id, sentVia: 'Indeed' });
    const del = await a.request({ method: 'DELETE', url: `/api/v1/opportunities/${opp}` });
    expect(del.statusCode).toBeLessThan(300);
    expect(await app.db.select().from(resumeSends).all()).toEqual([]);
    expect(await resumeRow(app, id)).toEqual(before);
  });

  it('deleting a user who has sends deletes everything of theirs (cascade, not restrict; tl)', async () => {
    const { app, a, b } = await boot();
    const opp = await createOpportunity(a);
    const id = await resume(app, a);
    await record(a, opp, { resumeId: id, sentVia: 'Indeed' });
    const otherOpp = await createOpportunity(b);
    const other = await resume(app, b);
    await record(b, otherOpp, { resumeId: other, sentVia: 'Email' });
    await app.db.delete(users).where(eq(users.id, a.userId)).run();
    const left = await app.db.select().from(resumeSends).all();
    expect(left.map((s) => s.userId)).toEqual([b.userId]);
  });
});

describe('locks: a send and a resume delete (Postgres-relevant; #158)', () => {
  it('a delete that comes while a send is being recorded waits for it, then archives', async () => {
    const { app, a } = await boot();
    const opp = await createOpportunity(a);
    const id = await resume(app, a);
    const [sent, deleted] = await heldApart(
      app,
      'resumeSends.record.locked',
      () => record(a, opp, { resumeId: id, sentVia: 'Indeed' }),
      () => a.request({ method: 'DELETE', url: `/api/v1/resumes/${id}` }),
    );
    expect(sent.statusCode, sent.body).toBe(201);
    expect(deleted.json()).toMatchObject({ outcome: 'archived' });
    expect((await listSends(a, opp)).json().items).toHaveLength(1);
  });

  it('a send that comes while the resume is being deleted waits, then finds it gone (404, never a 500)', async () => {
    const { app, a } = await boot();
    const opp = await createOpportunity(a);
    const id = await resume(app, a);
    const [deleted, sent] = await heldApart(
      app,
      'resumes.delete.locked',
      () => a.request({ method: 'DELETE', url: `/api/v1/resumes/${id}` }),
      () => record(a, opp, { resumeId: id, sentVia: 'Indeed' }),
    );
    expect(deleted.json()).toMatchObject({ outcome: 'deleted' });
    expect(sent.statusCode, sent.body).toBe(404);
    expect(await app.db.select().from(resumeSends).all()).toEqual([]);
  });
});

describe('isolation', () => {
  assertIsolated({
    name: "an opportunity's resume sends",
    create: async (c, app) => {
      const opp = await createOpportunity(c);
      await record(c, opp, { resumeId: await resume(app, c), sentVia: 'Indeed' });
      return opp;
    },
    read: (c, opp) => listSends(c, opp),
  });
  assertIsolated({
    name: "a resume's sends",
    create: async (c, app) => {
      const opp = await createOpportunity(c);
      const id = await resume(app, c);
      await record(c, opp, { resumeId: id, sentVia: 'Indeed' });
      return id;
    },
    read: (c, id) => c.request({ method: 'GET', url: `/api/v1/resumes/${id}/sends` }),
  });
  assertIsolated({
    name: 'removing a send',
    create: async (c, app) => {
      const opp = await createOpportunity(c);
      const sent = await record(c, opp, { resumeId: await resume(app, c), sentVia: 'Indeed' });
      return `${opp}/${sent.json().id as string}`;
    },
    read: (c, both) => {
      const [opp, send] = both.split('/') as [string, string];
      return removeSend(c, opp, send);
    },
  });
});

describe('test gaps (#172; qa on #164)', () => {
  /**
   * A send row of user `owner`'s, written directly: the API cannot make one that crosses users
   * (the routes check ownership first), so this stands in for a bug elsewhere. The readers'
   * own user filter is what must keep it out.
   */
  async function foreignSend(
    app: FastifyInstance,
    owner: TestClient,
    row: { opportunityId: string; resumeId: string },
  ) {
    await app.db
      .insert(resumeSends)
      .values({
        id: newId(),
        userId: owner.userId,
        ...row,
        sentAt: Date.now(),
        sentVia: 'Elsewhere',
        submissionId: null,
        createdAt: Date.now(),
      })
      .run();
  }

  it("a resume's summary ignores a send row of another user's (latestSends' user filter)", async () => {
    const { app, a, b } = await boot();
    const mine = await resume(app, a);
    await foreignSend(app, b, { opportunityId: await createOpportunity(b), resumeId: mine });
    const one = (await getResume(a, mine)).json();
    expect(one).toMatchObject({ status: 'final', submittedTo: null, submittedAt: null });
    const list = await a.request({ method: 'GET', url: '/api/v1/resumes' });
    const listed = (list.json().items as { id: string; submittedTo: string | null }[]).find(
      (r) => r.id === mine,
    );
    expect(listed).toMatchObject({ submittedTo: null });
  });

  it("the send lists ignore a send row of another user's (the lists' user filter)", async () => {
    const { app, a, b } = await boot();
    const myOpp = await createOpportunity(a);
    const mine = await resume(app, a);
    await foreignSend(app, b, { opportunityId: myOpp, resumeId: mine });
    expect((await listSends(a, myOpp)).json().items).toEqual([]);
    const byResume = await a.request({ method: 'GET', url: `/api/v1/resumes/${mine}/sends` });
    expect(byResume.json().items).toEqual([]);
  });

  // sec's rule on #164: another user's resume id is refused before any lock, so it can never be
  // made to wait on (or hold up) the owner's lock. With a's delete parked inside a's resume lock,
  // b's attempt on that resume must answer 404 at once, not queue behind it. Postgres only: on
  // SQLite the write gate holds every caller, even a plain read, while a transaction is open, so
  // there the oracle cannot tell "refused before the lock" from "queued behind it".
  it.runIf(testDialect === 'postgres')(
    "recording another user's resume answers at once while its owner holds the resume lock",
    async () => {
      const { app, a, b } = await boot();
      const id = await resume(app, a);
      const theirOpp = await createOpportunity(b);
      onSlowTransaction(() => undefined);
      const pause = pauseAt('resumes.delete.locked');
      const deleting = a.request({ method: 'DELETE', url: `/api/v1/resumes/${id}` });
      await pause.reached;
      const sent = record(b, theirOpp, { resumeId: id, sentVia: 'Indeed' });
      let seen;
      try {
        seen = await settledOrWaiting(app, sent, pause);
      } finally {
        pause.release();
      }
      expect(seen).toBe('settled');
      expect((await sent).statusCode).toBe(404);
      expect((await deleting).json()).toMatchObject({ outcome: 'deleted' });
      expect(await app.db.select().from(resumeSends).all()).toEqual([]);
    },
  );
});
