// Assisted apply on the demo fills only the visitor's own data
// (https://github.com/bgoleno/opportun/issues/544, slice 1 of #542). The demo's own submission
// switch stays off until #545 binds each attempt to its visitor (sec on #544), so these tests turn
// on the internal demoSubmissions flag to reach the rules built behind it.
import { newId } from '@opportun/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  DEMO_CANDIDATE_EMAIL,
  DEMO_CANDIDATE_NAME,
  DEMO_IDENTITY_VALUES,
  DEMO_USERS,
} from '../src/cli/seedDemoFixture';
import { submissionsEnabled } from '../src/config';
import {
  applicationSubmissions,
  jobs,
  opportunities,
  profiles,
  resumes,
  settings,
} from '../src/db/schema';
import { SNAPSHOT_JOB_KIND } from '../src/jobs/submissionSnapshot';
import { createDeviceToken } from '../src/lib/deviceTokens';
import { DEMO_RESUME_IDS_KEY, fixtureField, isFixtureIdentity } from '../src/lib/demoOwnData';
import { submissionDigest } from '../src/lib/submissionDigest';
import { createOpportunity } from '../src/repos/opportunities';
import { insertResume } from '../src/repos/resumes';
import { useApi } from './api';
import { PASSWORD, type TestClient } from './isolation';
import { api, requisition } from './submissionFixtures';

const boot = useApi();
const ON_THE_DEMO = { demo: true, submissions: true, demoSubmissions: true } as const;
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

/** An opportunity on a recognised, confirmed Greenhouse posting, ready for a draft. */
async function readyOpportunity(app: FastifyInstance, c: TestClient): Promise<string> {
  const opp = await createOpportunity(app.db, ctxOf(c), {
    companyName: 'Example Corp',
    // A title of its own: the same company and title twice is a duplicate.
    title: `Senior Platform Engineer ${newId().slice(-6)}`,
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

/** Records `ids` as the demo seed's own resumes, as seedDemo does. */
async function markSeeded(app: FastifyInstance, ids: string[]) {
  await app.db
    .insert(settings)
    .values({ key: DEMO_RESUME_IDS_KEY, userId: null, value: ids, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: settings.key, set: { value: ids } })
    .run();
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

/** A device token with the apply scope, made as the extension's pairing does. */
async function applyToken(app: FastifyInstance, c: TestClient): Promise<string> {
  return (await createDeviceToken(app.db, ctxOf(c), { name: 'x', scopes: ['apply:assist'] })).token;
}

const current = (app: FastifyInstance, token: string, url: string) =>
  app.inject({
    method: 'GET',
    url: `/api/v1/connector/apply/current?url=${encodeURIComponent(url)}`,
    headers: { authorization: `Bearer ${token}` },
  });

describe('the switch stays off on the demo until #545 (sec on #544)', () => {
  it('submissionsEnabled is off on the demo unless demoSubmissions is on, and on off the demo', () => {
    expect(submissionsEnabled({ submissions: true, demo: true })).toBe(false);
    expect(submissionsEnabled({ submissions: true, demo: true, demoSubmissions: true })).toBe(true);
    expect(submissionsEnabled({ submissions: true, demo: false })).toBe(true);
    // The off switch still wins on the demo.
    expect(submissionsEnabled({ submissions: false, demo: true, demoSubmissions: true })).toBe(
      false,
    );
  });

  it('a demo deployment as configured (no demoSubmissions) has no submission routes', async () => {
    const { app, a } = await boot({ demo: true, submissions: true });
    const res = await create(a, await readyOpportunity(app, a));
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('feature_unavailable');
    const mint = await api(a, 'POST', '/device-tokens', {
      name: 'Chrome',
      scopes: ['apply:assist'],
      password: PASSWORD,
    });
    expect(mint.json<{ error: { code: string } }>().error.code).toBe('scope_unavailable');
  });
});

describe('a demo draft starts empty, and is the visitor’s own (#544, criterion 2)', () => {
  it('nothing is prefilled, though the account has a profile', async () => {
    const { app, a } = await boot(ON_THE_DEMO);
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
    const { app, a } = await boot(ON_THE_DEMO);
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
    const { app, a } = await boot(ON_THE_DEMO);
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
    const { app, a } = await boot(ON_THE_DEMO);
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

describe('the resume is never the demo’s own (#544, criterion 3)', () => {
  it('a seeded resume, or one tailored from a seeded base, is refused at draft; the visitor’s own is accepted', async () => {
    const { app, a } = await boot(ON_THE_DEMO);
    const seeded = await finalResume(app, a);
    const tailored = await finalResume(app, a, seeded);
    const ownBase = await finalResume(app, a);
    const ownTailored = await finalResume(app, a, ownBase);
    await markSeeded(app, [seeded]);
    for (const resumeId of [seeded, tailored]) {
      const res = await create(a, await readyOpportunity(app, a), resumeId);
      expect(res.statusCode, resumeId).toBe(422);
      expect(res.json<{ error: unknown }>().error).toMatchObject({
        code: 'demo_fixture_resume',
        field: 'resume',
      });
    }
    const draft = await create(a, await readyOpportunity(app, a));
    const id = draft.json<{ id: string }>().id;
    const patched = await api(a, 'PATCH', `/submissions/${id}`, { resumeId: tailored });
    expect(patched.statusCode).toBe(422);
    for (const resumeId of [ownBase, ownTailored]) {
      expect((await create(a, await readyOpportunity(app, a), resumeId)).statusCode).toBe(201);
    }
  });

  it('a seeded resume put on the attempt behind the server’s back is refused at review', async () => {
    const { app, a } = await boot(ON_THE_DEMO);
    const seeded = await finalResume(app, a);
    await markSeeded(app, [seeded]);
    const draft = await create(a, await readyOpportunity(app, a));
    const id = draft.json<{ id: string }>().id;
    await app.db
      .update(applicationSubmissions)
      .set({ resumeId: seeded })
      .where(eq(applicationSubmissions.id, id))
      .run();
    const res = await review(a, id);
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('demo_fixture_resume');
  });
});

describe('the fixture-identity backstop (#544, criterion 3)', () => {
  const account = DEMO_USERS[1]!;
  const cases: [string, string][] = [
    ['fullName', account.displayName],
    ['email', account.email.toUpperCase()],
    ['fullName', `${DEMO_CANDIDATE_NAME.toLowerCase().replace(' ', '   ')}`],
    ['email', DEMO_CANDIDATE_EMAIL],
  ];

  for (const [field, value] of cases) {
    it(`review refuses ${field} = "${value}", naming the field`, async () => {
      const { app, a } = await boot(ON_THE_DEMO);
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

  it('generic values identify nobody and are not refused', async () => {
    const { app, a } = await boot(ON_THE_DEMO);
    const draft = await create(a, await readyOpportunity(app, a));
    const id = draft.json<{ id: string }>().id;
    await api(a, 'PATCH', `/submissions/${id}`, {
      fields: { fullName: 'Jane Visitor', country: 'United States' },
    });
    expect((await review(a, id)).statusCode).toBe(200);
  });

  it('a fixture value put back after review is refused at handoff and at /current', async () => {
    const { app, a } = await boot(ON_THE_DEMO);
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

  it('compares after case and whitespace, and a phone by its digits', () => {
    expect(isFixtureIdentity('fullName', ' demo   user 1 ')).toBe(true);
    expect(isFixtureIdentity('fullName', 'Demo User 12')).toBe(false);
    expect(fixtureField({ city: 'Seattle', email: 'DEMO-ADMIN@opportun-demo.example' })).toBe(
      'email',
    );
    expect(fixtureField({ fullName: 'Jane Visitor' })).toBeNull();
    for (const v of DEMO_IDENTITY_VALUES) expect(isFixtureIdentity('any', v), v).toBe(true);
  });
});

describe('device tokens: at most 20 active per demo account (sec)', () => {
  const mint = (c: TestClient) =>
    api(c, 'POST', '/device-tokens', {
      name: 'Chrome',
      scopes: ['apply:assist'],
      password: PASSWORD,
    });

  it('the 21st is refused while 20 are active, and one more is allowed once one is revoked', async () => {
    const { app, a } = await boot(ON_THE_DEMO);
    const made = [];
    for (let i = 0; i < 20; i++)
      made.push(
        await createDeviceToken(app.db, ctxOf(a), { name: `t${i}`, scopes: ['apply:assist'] }),
      );
    const refused = await mint(a);
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('device_token_limit');
    expect((await api(a, 'DELETE', `/device-tokens/${made[0]!.meta.id}`)).statusCode).toBe(204);
    expect((await mint(a)).statusCode).toBe(201);
  });

  it('off the demo there is no such cap', async () => {
    const { app, a } = await boot({ submissions: true });
    for (let i = 0; i < 20; i++)
      await createDeviceToken(app.db, ctxOf(a), { name: `t${i}`, scopes: ['apply:assist'] });
    expect((await mint(a)).statusCode).toBe(201);
  });
});
