// Assisted apply on the demo fills only the visitor's own data
// (https://github.com/bgoleno/opportun/issues/544, slice 1 of #542). The switch is on for the
// demo since #545, which binds each attempt to its visitor (test/demoActorBinding.test.ts).
import { SNAPSHOT_JOB_KIND } from '../src/lib/submissionSnapshotQueue';
import { newId } from '@opportun/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  DEMO_CANDIDATE_EMAIL,
  DEMO_CANDIDATE_NAME,
  DEMO_CANDIDATE_PHONE,
  DEMO_IDENTITY_VALUES,
  DEMO_RESUME_BASE_TEXT,
  DEMO_USERS,
} from '../src/lib/demo/fixture';
import {
  applicationSubmissions,
  auditLog,
  deviceTokens,
  jobs,
  opportunities,
  profiles,
  resumes,
} from '../src/db/schema';
import { createDeviceToken } from '../src/lib/deviceTokens';
import { fixtureField, isFixtureIdentity } from '../src/lib/demoOwnData';
import { submissionDigest } from '../src/lib/submissionDigest';
import { createOpportunity } from '../src/repos/opportunities';
import { insertResume } from '../src/repos/resumes';
import { useApi } from './api';
import { PASSWORD, sharedDemoUser, type TestClient } from './isolation';
import { api, requisition } from './submissionFixtures';

const boot = useApi();
const ON_THE_DEMO = { demo: true, submissions: true } as const;

/**
 * A demo server, signed in as one of the seed's pinned accounts: a shared demo account, where the
 * own-data rules and the binding apply (decision 133). `a` is that shared account.
 */
async function bootShared(overrides: Record<string, unknown> = {}) {
  const env = await boot({ ...ON_THE_DEMO, ...overrides });
  return { ...env, a: await sharedDemoUser(env.app, 1) };
}
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

/** An opportunity on a recognised, confirmed Greenhouse posting, ready for a draft. */
async function readyOpportunity(app: FastifyInstance, c: TestClient): Promise<string> {
  const opp = await createOpportunity(app.db, ctxOf(c), {
    companyName: 'Example Corp',
    // A title of its own: the same company and title twice is a duplicate.
    title: `Senior Platform Engineer ${newId()}`,
    sourceKind: 'manual',
  });
  await app.db
    .update(opportunities)
    .set({ stage: 'interested', atsJobRef: requisition(), postingState: 'confirmed' })
    .where(eq(opportunities.id, opp.id))
    .run();
  return opp.id;
}

/** A final resume of the user's own; `parent` makes it a copy tailored from that resume. */
async function finalResume(app: FastifyInstance, c: TestClient, parent: string | null = null) {
  const r = await insertResume(app.db, ctxOf(c), {
    kind: parent === null ? 'base' : 'tailored',
    title: 'My Resume',
    store: 'local_file',
    docRef: `resumes/${newId()}.txt`,
    opportunityId: null,
    parentResumeId: parent,
  });
  await app.db.update(resumes).set({ status: 'final' }).where(eq(resumes.id, r.id)).run();
  return r.id;
}

const create = (c: TestClient, oppId: string, resumeId?: string) =>
  api(c, 'POST', `/opportunities/${oppId}/submissions`, {
    idempotencyKey: crypto.randomUUID(),
    ...(resumeId === undefined ? {} : { resumeId }),
  });

async function review(c: TestClient, id: string) {
  const current = await api(c, 'GET', `/submissions/${id}`);
  return await api(c, 'POST', `/submissions/${id}/review`, {
    reviewDigest: current.json<{ reviewDigest: string }>().reviewDigest,
    acknowledged: true,
  });
}

/** A resume-less demo draft with `fields`, reviewed and handed off. */
async function handedOff(app: FastifyInstance, c: TestClient, fields: Record<string, string>) {
  const oppId = await readyOpportunity(app, c);
  const created = await create(c, oppId);
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json<{ id: string }>().id;
  expect((await api(c, 'PATCH', `/submissions/${id}`, { fields })).statusCode).toBe(200);
  expect((await review(c, id)).statusCode).toBe(200);
  const handed = await api(c, 'POST', `/submissions/${id}/handoff`, {});
  expect(handed.statusCode, handed.body).toBe(200);
  const row = (await app.db
    .select()
    .from(applicationSubmissions)
    .where(eq(applicationSubmissions.id, id))
    .get())!;
  return { id, destinationUrl: row.destinationUrl };
}

/**
 * A device token with the apply scope, made as the extension's pairing does: through the route, by
 * this visitor's session, so on the demo it is given this visitor's attempts (#545).
 */
async function applyToken(_app: FastifyInstance, c: TestClient): Promise<string> {
  const res = await api(c, 'POST', '/device-tokens', {
    name: 'Chrome',
    scopes: ['apply:assist'],
    password: PASSWORD,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ token: string }>().token;
}

const current = (app: FastifyInstance, token: string, url: string) =>
  app.inject({
    method: 'GET',
    url: `/api/v1/connector/apply/current?url=${encodeURIComponent(url)}`,
    headers: { authorization: `Bearer ${token}` },
  });

describe('a demo draft starts empty, and is the visitor’s own (#544, criterion 2)', () => {
  it('GET /profile/application-details offers nothing on the demo (tl on #550)', async () => {
    const { app, a } = await bootShared();
    const now = Date.now();
    await app.db
      .insert(profiles)
      .values({ userId: a.userId, fullName: 'Someone Else', createdAt: now, updatedAt: now })
      .run();
    const res = await api(a, 'GET', '/profile/application-details');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ values: [], leftOut: [] });
  });

  it('nothing is prefilled, though the account has a profile', async () => {
    const { app, a } = await bootShared();
    const now = Date.now();
    await app.db
      .insert(profiles)
      .values({
        userId: a.userId,
        fullName: 'Someone Else',
        email: 'someone@example.com',
        phone: '+1 555 0100',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: profiles.userId,
        set: { fullName: 'Someone Else', email: 'someone@example.com', updatedAt: now },
      })
      .run();
    const created = await create(a, await readyOpportunity(app, a));
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json<{ fields: Record<string, string> }>().fields).toEqual({});
  });

  it('saveToProfile is refused on the demo, and neither the draft nor the profile changes', async () => {
    const { app, a } = await bootShared();
    const created = await create(a, await readyOpportunity(app, a));
    const id = created.json<{ id: string }>().id;
    const res = await api(a, 'PATCH', `/submissions/${id}`, {
      fields: { fullName: 'Jane Visitor' },
      saveToProfile: ['fullName'],
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('unavailable_on_demo');
    const after = await api(a, 'GET', `/submissions/${id}`);
    expect(after.json<{ fields: Record<string, string> }>().fields).toEqual({});
    const profile = await app.db.select().from(profiles).where(eq(profiles.userId, a.userId)).get();
    expect(profile?.fullName ?? null).toBeNull();
  });
});

describe('a demo attempt may carry no resume (tl on #544)', () => {
  it('is created, reviewed and handed off with no resume, and no snapshot job runs', async () => {
    const { app, a } = await bootShared();
    const { id } = await handedOff(app, a, { fullName: 'Jane Visitor' });
    const row = (await app.db
      .select()
      .from(applicationSubmissions)
      .where(eq(applicationSubmissions.id, id))
      .get())!;
    expect(row).toMatchObject({ resumeId: null, resumeStore: null, resumeAttachmentId: null });
    const snapshotJobs = await app.db
      .select()
      .from(jobs)
      .where(eq(jobs.kind, SNAPSHOT_JOB_KIND))
      .all();
    expect(snapshotJobs).toEqual([]);
  });

  it('/current sends the resume as an object of nulls, the shape the extension reads, and /snapshot is 404', async () => {
    const { app, a } = await bootShared();
    const { id, destinationUrl } = await handedOff(app, a, { fullName: 'Jane Visitor' });
    const token = await applyToken(app, a);
    const res = await current(app, token, destinationUrl);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ attempt: { resume: unknown; fields: unknown } }>();
    expect(body.attempt.resume).toStrictEqual({
      title: null,
      snapshotState: null,
      filename: null,
      bytes: null,
    });
    expect(body.attempt.fields).toEqual({ fullName: 'Jane Visitor' });
    const snap = await app.inject({
      method: 'GET',
      url: `/api/v1/connector/apply/${id}/snapshot`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(snap.statusCode).toBe(404);
  });

  it('off the demo a resume is still required', async () => {
    const { app, a } = await boot({ submissions: true });
    const res = await create(a, await readyOpportunity(app, a));
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).not.toBe('demo_fixture_resume');
  });
});

describe('no resume on a demo attempt (#544, criterion 3; tl and sec on #550)', () => {
  // Every resume on the demo is the seed's or a copy of one, so none is allowed: telling seeded ones
  // apart by their parents failed open once a base was deleted (parent_resume_id is ON DELETE SET
  // NULL). There is no seeded-ids row to be missing any more: nothing here reads one.
  async function threeResumes(app: FastifyInstance, c: TestClient) {
    const seeded = await finalResume(app, c);
    const tailored = await finalResume(app, c, seeded);
    // A copy whose base was deleted: its parent is null now, and it still comes from the seed.
    const orphanBase = await finalResume(app, c);
    const orphan = await finalResume(app, c, orphanBase);
    await app.db.delete(resumes).where(eq(resumes.id, orphanBase)).run();
    const row = await app.db.select().from(resumes).where(eq(resumes.id, orphan)).get();
    expect(row?.parentResumeId).toBeNull();
    return { seeded, tailored, orphan };
  }
  const refusedResume = { code: 'resume_unavailable_on_demo', field: 'resume' };

  it('each kind is refused at create and at PATCH', async () => {
    const { app, a } = await bootShared();
    const all = await threeResumes(app, a);
    for (const [kind, resumeId] of Object.entries(all)) {
      const res = await create(a, await readyOpportunity(app, a), resumeId);
      expect(res.statusCode, kind).toBe(422);
      expect(res.json<{ error: unknown }>().error, kind).toMatchObject(refusedResume);
      const draft = await create(a, await readyOpportunity(app, a));
      const id = draft.json<{ id: string }>().id;
      const patched = await api(a, 'PATCH', `/submissions/${id}`, { resumeId });
      expect(patched.statusCode, kind).toBe(422);
      expect(patched.json<{ error: unknown }>().error, kind).toMatchObject(refusedResume);
    }
  });

  it('each kind put on the attempt behind the server’s back is refused at review and at handoff', async () => {
    const { app, a } = await bootShared();
    const all = await threeResumes(app, a);
    const putOn = async (id: string, resumeId: string) =>
      await app.db
        .update(applicationSubmissions)
        .set({ resumeId, resumeStore: 'local_file', resumeTitle: 'My Resume' })
        .where(eq(applicationSubmissions.id, id))
        .run();
    for (const [kind, resumeId] of Object.entries(all)) {
      const draft = await create(a, await readyOpportunity(app, a));
      const id = draft.json<{ id: string }>().id;
      await putOn(id, resumeId);
      const reviewed = await review(a, id);
      expect(reviewed.statusCode, kind).toBe(422);
      expect(reviewed.json<{ error: unknown }>().error, kind).toMatchObject(refusedResume);

      const other = await create(a, await readyOpportunity(app, a));
      const otherId = other.json<{ id: string }>().id;
      expect((await review(a, otherId)).statusCode).toBe(200);
      await putOn(otherId, resumeId);
      const handoff = await api(a, 'POST', `/submissions/${otherId}/handoff`, {});
      expect(handoff.statusCode, kind).toBe(422);
      expect(handoff.json<{ error: unknown }>().error, kind).toMatchObject(refusedResume);
    }
  });

  it('a resume the server no longer holds, but whose copy is still on the attempt, is refused too', async () => {
    const { app, a } = await bootShared();
    const draft = await create(a, await readyOpportunity(app, a));
    const id = draft.json<{ id: string }>().id;
    // The resume row went (resume_id set null), and the attempt kept its copied facts.
    await app.db
      .update(applicationSubmissions)
      .set({ resumeId: null, resumeStore: 'local_file', resumeTitle: 'My Resume' })
      .where(eq(applicationSubmissions.id, id))
      .run();
    const res = await review(a, id);
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: unknown }>().error).toMatchObject(refusedResume);
  });
});

describe('the fixture-identity backstop (#544, criterion 3)', () => {
  const account = DEMO_USERS[1]!;
  const cases: [string, string][] = [
    ['fullName', account.displayName],
    ['email', account.email.toUpperCase()],
    ['fullName', `${DEMO_CANDIDATE_NAME.toLowerCase().replace(' ', '   ')}`],
    ['email', DEMO_CANDIDATE_EMAIL],
    // #671: the seed's phone, punctuated another way: compared by its digits.
    ['phone', '+1 (415) 555-0134'],
    // #682 (qa on #676): and without its country code.
    ['phone', '415-555-0134'],
    // #782 (qa's regression pass): under a field other than phone.
    ['mobile', '415-555-0134'],
  ];

  it('the seed carries a phone number, and it is one of the demo identity values (#671)', () => {
    expect(DEMO_CANDIDATE_PHONE.replace(/\D/g, '')).toBe('14155550134');
    expect(DEMO_RESUME_BASE_TEXT).toContain(DEMO_CANDIDATE_PHONE);
    expect(DEMO_IDENTITY_VALUES).toContain(DEMO_CANDIDATE_PHONE);
  });

  for (const [field, value] of cases) {
    it(`review refuses ${field} = "${value}", naming the field`, async () => {
      const { app, a } = await bootShared();
      const draft = await create(a, await readyOpportunity(app, a));
      const id = draft.json<{ id: string }>().id;
      const patched = await api(a, 'PATCH', `/submissions/${id}`, { fields: { [field]: value } });
      expect(patched.statusCode).toBe(200);
      const res = await review(a, id);
      expect(res.statusCode).toBe(422);
      expect(res.json<{ error: unknown }>().error).toMatchObject({
        code: 'demo_fixture_value',
        field,
      });
    });
  }

  it('review refuses the candidate’s name split over firstName and lastName (qa on #550)', async () => {
    const { app, a } = await bootShared();
    const draft = await create(a, await readyOpportunity(app, a));
    const id = draft.json<{ id: string }>().id;
    await api(a, 'PATCH', `/submissions/${id}`, {
      fields: { firstName: 'Avery', lastName: 'Chen' },
    });
    const res = await review(a, id);
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: unknown }>().error).toMatchObject({
      code: 'demo_fixture_value',
      field: 'firstName',
    });
  });

  it('generic values identify nobody and are not refused', async () => {
    const { app, a } = await bootShared();
    const draft = await create(a, await readyOpportunity(app, a));
    const id = draft.json<{ id: string }>().id;
    await api(a, 'PATCH', `/submissions/${id}`, {
      fields: { fullName: 'Jane Visitor', country: 'United States' },
    });
    expect((await review(a, id)).statusCode).toBe(200);
  });

  it('a fixture value put back after review is refused at handoff and at /current', async () => {
    const { app, a } = await bootShared();
    const draft = await create(a, await readyOpportunity(app, a));
    const id = draft.json<{ id: string }>().id;
    await api(a, 'PATCH', `/submissions/${id}`, { fields: { fullName: 'Jane Visitor' } });
    expect((await review(a, id)).statusCode).toBe(200);
    const putBack = () =>
      app.db
        .update(applicationSubmissions)
        .set({ fields: { fullName: 'Jane Visitor', email: account.email } })
        .where(eq(applicationSubmissions.id, id))
        .run();
    await putBack();
    const handoff = await api(a, 'POST', `/submissions/${id}/handoff`, {});
    expect(handoff.statusCode).toBe(422);
    expect(handoff.json<{ error: unknown }>().error).toMatchObject({
      code: 'demo_fixture_value',
      field: 'email',
    });

    // /current already gives a changed attempt nothing (review_stale). The backstop is for a row
    // whose digest was made to match too, which only a write past every route could do.
    const other = await handedOff(app, a, { fullName: 'Jane Visitor' });
    const before = (await app.db
      .select()
      .from(applicationSubmissions)
      .where(eq(applicationSubmissions.id, other.id))
      .get())!;
    const tampered = { ...before, fields: { fullName: account.displayName } };
    await app.db
      .update(applicationSubmissions)
      .set({ fields: tampered.fields, reviewDigest: submissionDigest(tampered) })
      .where(eq(applicationSubmissions.id, other.id))
      .run();
    const res = await current(app, await applyToken(app, a), other.destinationUrl);
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: unknown }>().error).toMatchObject({
      code: 'demo_fixture_value',
      field: 'fullName',
    });
  });

  it('off the demo, the same values are an ordinary application', async () => {
    const { app, a } = await boot({ submissions: true });
    const oppId = await readyOpportunity(app, a);
    const created = await create(a, oppId, await finalResume(app, a));
    const id = created.json<{ id: string }>().id;
    await app.jobs.drain();
    await api(a, 'PATCH', `/submissions/${id}`, { fields: { fullName: account.displayName } });
    expect((await review(a, id)).statusCode).toBe(200);
  });

  // #682 (qa on #676): the seeded number typed without "+1", or with the international prefix, or
  // punctuated any way, is the same number; another number, or another country's, is not.
  it.each([
    '415-555-0134',
    '(415) 555 0134',
    '4155550134',
    '1-415-555-0134',
    '+1.415.555.0134',
    '00 1 415 555 0134',
    '+1 415 555 0134',
    // #726 (tl and qa on #725): the 011 exit prefix, and a trailing extension.
    '011 1 415 555 0134',
    '+1 415 555 0134 ext 2',
    '415-555-0134 x12',
    '(415) 555-0134 #3',
    '415.555.0134 extension 45',
    // qa on #762: an extension of seven digits or more.
    '+1 415 555 0134 ext 1234567',
  ])('the seeded phone as "%s" is the demo\'s', (value) => {
    expect(isFixtureIdentity('phone', value)).toBe(true);
    expect(fixtureField({ phone: value, city: 'Seattle' })).toBe('phone');
  });

  // #782 (qa's regression pass): the seeded phone in any field, not only `phone`, in every format
  // above. Field keys are whatever the form names (FIELD_KEY in core), so no list of phone-like
  // names could be complete; the seed's phone is the only identity value with seven digits or more.
  const PHONE_FORMATS = [
    '415-555-0134',
    '(415) 555 0134',
    '4155550134',
    '1-415-555-0134',
    '+1.415.555.0134',
    '00 1 415 555 0134',
    '+1 415 555 0134',
    '011 1 415 555 0134',
    '+1 415 555 0134 ext 2',
    '415-555-0134 x12',
    '(415) 555-0134 #3',
    '415.555.0134 extension 45',
    '+1 415 555 0134 ext 1234567',
  ];
  for (const key of ['mobile', 'tel', 'telephone', 'cellPhone', 'workPhone', 'question_1234']) {
    it.each(PHONE_FORMATS)(
      `the seeded phone under ${key} as "%s" is the demo's (#782)`,
      (value) => {
        expect(isFixtureIdentity(key, value)).toBe(true);
        expect(fixtureField({ [key]: value, city: 'Seattle' })).toBe(key);
      },
    );
    it.each(['415-555-0135', '+44 415 555 0134', '+1 206 555 0100', '555-0134'])(
      `a real phone under ${key} ("%s") is accepted (#782)`,
      (value) => {
        expect(isFixtureIdentity(key, value)).toBe(false);
        expect(fixtureField({ [key]: value })).toBeNull();
      },
    );
  }

  it.each([
    '415-555-0135',
    '+44 415 555 0134',
    '+1 415 555 01345',
    '555-0134',
    '+1 415 555 0135 ext 2',
    '011 44 415 555 0134',
  ])('"%s" is not the seeded phone', (value) => {
    expect(isFixtureIdentity('phone', value)).toBe(false);
  });

  it('compares after case and whitespace, and a phone by its digits', () => {
    expect(isFixtureIdentity('fullName', ' demo   user 1 ')).toBe(true);
    expect(isFixtureIdentity('fullName', 'Demo User 12')).toBe(false);
    expect(fixtureField({ city: 'Seattle', email: 'DEMO-ADMIN@opportun-demo.example' })).toBe(
      'email',
    );
    expect(fixtureField({ fullName: 'Jane Visitor' })).toBeNull();
    // A name split over two fields is one name (qa on #550); a first name alone names nobody.
    expect(fixtureField({ firstName: 'Avery', lastName: ' CHEN ' })).toBe('firstName');
    expect(fixtureField({ firstName: 'Avery', lastName: 'Visitor' })).toBeNull();
    expect(fixtureField({ firstName: 'Avery' })).toBeNull();
    // Any address at the demo's own domain, listed or not, and a full-width form of a listed name.
    expect(isFixtureIdentity('email', 'someone-new@OPPORTUN-DEMO.example')).toBe(true);
    // A subdomain of it too (qa on #550), and not a domain that merely ends in the same letters.
    expect(isFixtureIdentity('email', 'x@mail.opportun-demo.example')).toBe(true);
    expect(isFixtureIdentity('email', 'x@notopportun-demo.example')).toBe(false);
    expect(isFixtureIdentity('email', 'jane@example.com')).toBe(false);
    expect(isFixtureIdentity('fullName', 'Ａｖｅｒｙ Ｃｈｅｎ')).toBe(true);
    for (const v of DEMO_IDENTITY_VALUES) expect(isFixtureIdentity('any', v), v).toBe(true);
  });
});

describe('device tokens: at most 20 active per demo account (sec; tl on #550)', () => {
  const mint = (c: TestClient) =>
    api(c, 'POST', '/device-tokens', {
      name: 'Chrome',
      scopes: ['apply:assist'],
      password: PASSWORD,
    });

  it('the 21st mint leaves exactly 20 active: the oldest is revoked, and audited as a manual revoke is', async () => {
    const { app, a } = await bootShared();
    const made = [];
    for (let i = 0; i < 20; i++) {
      made.push(
        await createDeviceToken(app.db, ctxOf(a), { name: `t${i}`, scopes: ['apply:assist'] }),
      );
      await new Promise((r) => setTimeout(r, 2)); // distinct createdAt, so "oldest" is defined
    }
    const res = await mint(a);
    expect(res.statusCode, res.body).toBe(201);
    const rows = await app.db
      .select()
      .from(deviceTokens)
      .where(eq(deviceTokens.userId, a.userId))
      .all();
    const active = rows.filter((r) => r.revokedAt === null);
    expect(active).toHaveLength(20);
    const revoked = rows.filter((r) => r.revokedAt !== null).map((r) => r.id);
    expect(revoked).toEqual([made[0]!.meta.id]);
    expect(active.map((r) => r.id)).toContain(res.json<{ id: string }>().id);
    const entries = await app.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.event, 'device_token.revoked'))
      .all();
    expect(entries.map((e) => e.detail)).toEqual([{ id: made[0]!.meta.id, name: 't0' }]);
    expect(entries[0]!.userId).toBe(a.userId);
    // The revoked one fails on its next request.
    const old = await app.inject({
      method: 'GET',
      url: '/api/v1/connector/apply/current?url=https%3A%2F%2Fboards.greenhouse.io%2Fx%2Fjobs%2F1',
      headers: { authorization: `Bearer ${made[0]!.token}` },
    });
    expect(old.statusCode).toBe(401);
  });

  it('off the demo there is no such cap', async () => {
    const { app, a } = await boot({ submissions: true });
    for (let i = 0; i < 20; i++)
      await createDeviceToken(app.db, ctxOf(a), { name: `t${i}`, scopes: ['apply:assist'] });
    expect((await mint(a)).statusCode).toBe(201);
  });
});
