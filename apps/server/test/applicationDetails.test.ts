// A new application draft starts filled with what Opportun holds for the user, each value with
// its source, and the user can save a value to their profile in the same request (#411, slice 1
// of https://github.com/bgoleno/opportun/issues/401; tl's design note issuecomment-6794002888).
// The rule itself (the order of sources, LinkedIn, Links) is pinned in packages/core; these
// cover loading it, the draft, the PATCH save, /profile and the audit. Every name, address,
// posting and link here is made up.
import { newId, type AtsJobRef } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  applicationSubmissions,
  auditLog,
  opportunities,
  profiles,
  resumes,
  users,
} from '../src/db/schema';
import type { UserCtx } from '../src/repos/base';
import { createOpportunity } from '../src/repos/opportunities';
import { insertResume } from '../src/repos/resumes';
import { useApi } from './api';
import type { TestClient } from './isolation';

/** The test users' password (test/isolation.ts registers every user with it). */
const PASSWORD = 'correct horse battery';
const boot = useApi();
const ON = { submissions: true };
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });

const api = (
  c: TestClient,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  payload?: Record<string, unknown>,
) => c.request({ method, url: `/api/v1${url}`, ...(payload === undefined ? {} : { payload }) });

/** A requisition of its own, so one attempt is never another's re-apply. */
function freshRef(): AtsJobRef {
  const externalId = String(Math.floor(1_000_000 + Math.random() * 8_999_999));
  return {
    kind: 'ats_greenhouse',
    org: 'examplecorp',
    externalId,
    url: `https://boards.greenhouse.io/examplecorp/jobs/${externalId}`,
  };
}

async function eligibleOpportunity(
  app: FastifyInstance,
  c: TestClient,
  companyName = 'Example Corp',
) {
  const opp = await createOpportunity(app.db, ctxOf(c), {
    companyName,
    title: `Senior Example Engineer ${newId().slice(-6)}`,
    sourceKind: 'manual',
  });
  await app.db
    .update(opportunities)
    .set({ stage: 'interested', atsJobRef: freshRef(), postingState: 'confirmed' })
    .where(eq(opportunities.id, opp.id))
    .run();
  return opp;
}

async function finalResume(app: FastifyInstance, c: TestClient): Promise<string> {
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

/** A new draft for a fresh eligible opportunity, through the route the step uses. */
async function newDraft(app: FastifyInstance, c: TestClient, companyName?: string) {
  const opp = await eligibleOpportunity(app, c, companyName);
  const resumeId = await finalResume(app, c);
  const idempotencyKey = crypto.randomUUID();
  const res = await api(c, 'POST', `/opportunities/${opp.id}/submissions`, {
    idempotencyKey,
    resumeId,
  });
  expect(res.statusCode, res.body).toBe(201);
  return {
    id: res.json<{ id: string }>().id,
    fields: res.json<{ fields: Record<string, string> }>().fields,
    oppId: opp.id,
    resumeId,
    idempotencyKey,
  };
}

/** An earlier attempt with these fields, reviewed at `reviewedAt` (as the review leaves it). */
async function reviewedAttempt(
  app: FastifyInstance,
  c: TestClient,
  fields: Record<string, string>,
  reviewedAt: number,
  companyName = 'Earlier Corp',
) {
  const d = await newDraft(app, c, companyName);
  const patched = await api(c, 'PATCH', `/submissions/${d.id}`, { fields });
  expect(patched.statusCode, patched.body).toBe(200);
  await app.db
    .update(applicationSubmissions)
    .set({ reviewedAt })
    .where(eq(applicationSubmissions.id, d.id))
    .run();
  return d;
}

async function setAccount(app: FastifyInstance, c: TestClient, displayName: string) {
  await app.db.update(users).set({ displayName }).where(eq(users.id, c.userId)).run();
}

const accountEmail = async (app: FastifyInstance, c: TestClient) =>
  (await app.db.select({ email: users.email }).from(users).where(eq(users.id, c.userId)).get())
    ?.email;

const profileRow = async (app: FastifyInstance, c: TestClient) =>
  await app.db.select().from(profiles).where(eq(profiles.userId, c.userId)).get();

const prefill = async (c: TestClient) => {
  const res = await api(c, 'GET', '/profile/application-details');
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{
    values: { key: string; value: string; source: Record<string, unknown> }[];
    leftOut: { key: string; source: Record<string, unknown> }[];
  }>();
};

const FULL_PROFILE = {
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  phone: '+1 555 0100',
  location: 'Springfield',
  workAuth: 'Authorised to work in the US',
  links: [
    { label: 'LinkedIn', url: 'https://www.linkedin.com/in/jane-doe-example' },
    { label: 'GitHub', url: 'https://github.com/jane-doe-example' },
  ],
  applicationDetails: { firstName: 'Jane', lastName: 'Doe', websiteUrl: 'https://jane.example' },
};

describe('a new draft is filled from what Opportun holds (#411)', () => {
  it('a filled profile gives a draft with those fields', async () => {
    const { app, a } = await boot(ON);
    expect((await api(a, 'PUT', '/profile', FULL_PROFILE)).statusCode).toBe(200);
    const d = await newDraft(app, a);
    expect(d.fields).toEqual({
      firstName: 'Jane',
      lastName: 'Doe',
      fullName: 'Jane Doe',
      email: 'jane@example.com',
      phone: '+1 555 0100',
      location: 'Springfield',
      workAuthorization: 'Authorised to work in the US',
      linkedinUrl: 'https://www.linkedin.com/in/jane-doe-example',
      websiteUrl: 'https://jane.example',
      links: 'https://www.linkedin.com/in/jane-doe-example, https://github.com/jane-doe-example',
    });
    const row = await app.db
      .select({ fields: applicationSubmissions.fields })
      .from(applicationSubmissions)
      .where(eq(applicationSubmissions.id, d.id))
      .get();
    expect(row?.fields).toEqual(d.fields);
  });

  it('an empty profile and no earlier application: only the account, Email and Full name', async () => {
    const { app, a } = await boot(ON);
    await setAccount(app, a, 'Jane Doe');
    const d = await newDraft(app, a);
    expect(d.fields).toEqual({ fullName: 'Jane Doe', email: await accountEmail(app, a) });
    expect(await prefill(a)).toEqual({
      values: [
        { key: 'fullName', value: 'Jane Doe', source: { kind: 'account' } },
        { key: 'email', value: await accountEmail(app, a), source: { kind: 'account' } },
      ],
      leftOut: [],
    });
  });

  it('takes each field from the profile, then the account, then the last reviewed application', async () => {
    const { app, a } = await boot(ON);
    await setAccount(app, a, 'Account Name');
    const earlier = await reviewedAttempt(
      app,
      a,
      { firstName: 'Janet', phone: '+1 555 0199', fullName: 'Old Name', location: 'Shelbyville' },
      Date.now() - 60_000,
    );
    await api(a, 'PUT', '/profile', { phone: '+1 555 0100' });
    const p = await prefill(a);
    const source = (key: string) => p.values.find((v) => v.key === key);
    expect(source('phone')).toMatchObject({ value: '+1 555 0100', source: { kind: 'profile' } });
    expect(source('fullName')).toMatchObject({
      value: 'Account Name',
      source: { kind: 'account' },
    });
    expect(source('firstName')).toMatchObject({
      value: 'Janet',
      source: {
        kind: 'application',
        submissionId: earlier.id,
        opportunityId: earlier.oppId,
        companyName: 'Earlier Corp',
      },
    });
    expect(source('location')?.source).toMatchObject({ kind: 'application' });
    const d = await newDraft(app, a);
    expect(d.fields).toMatchObject({
      phone: '+1 555 0100',
      fullName: 'Account Name',
      firstName: 'Janet',
      location: 'Shelbyville',
    });
  });

  it('the most recently reviewed attempt decides, and an older one never fills a gap', async () => {
    const { app, a } = await boot(ON);
    const older = await reviewedAttempt(
      app,
      a,
      { firstName: 'Older', websiteUrl: 'https://older.example' },
      Date.now() - 120_000,
      'Older Corp',
    );
    const newer = await reviewedAttempt(
      app,
      a,
      { firstName: 'Newer' },
      Date.now() - 60_000,
      'Newer Corp',
    );
    // A draft never reviewed is not "an application": it does not count, however new.
    await newDraft(app, a);
    const d = await newDraft(app, a);
    expect(d.fields.firstName).toBe('Newer');
    expect(d.fields.websiteUrl).toBeUndefined();
    const first = (await prefill(a)).values.find((v) => v.key === 'firstName');
    expect(first?.source).toMatchObject({ submissionId: newer.id, companyName: 'Newer Corp' });
    expect(older.id).not.toBe(newer.id);
  });

  it("a value that fails today's checks is left out and named, and nothing comes in its place", async () => {
    const { app, a } = await boot(ON);
    await reviewedAttempt(app, a, { phone: '+1 555 0199' }, Date.now() - 60_000);
    await api(a, 'PUT', '/profile', { phone: 'call me on weekdays' });
    const p = await prefill(a);
    expect(p.values.find((v) => v.key === 'phone')).toBeUndefined();
    expect(p.leftOut).toEqual([{ key: 'phone', source: { kind: 'profile' } }]);
    const d = await newDraft(app, a);
    expect(d.fields.phone).toBeUndefined();
  });

  it('a full name never becomes a first or last name', async () => {
    const { app, a } = await boot(ON);
    await setAccount(app, a, 'Jane Doe');
    await api(a, 'PUT', '/profile', { fullName: 'Jane Q. Doe' });
    const d = await newDraft(app, a);
    expect(d.fields.fullName).toBe('Jane Q. Doe');
    expect(d.fields.firstName).toBeUndefined();
    expect(d.fields.lastName).toBeUndefined();
  });

  it("another user's profile and applications are never read", async () => {
    const { app, a, b } = await boot(ON);
    await setAccount(app, a, 'Ada Example');
    expect((await api(b, 'PUT', '/profile', FULL_PROFILE)).statusCode).toBe(200);
    await reviewedAttempt(app, b, { firstName: 'Bea', location: 'Ogdenville' }, Date.now());
    const d = await newDraft(app, a);
    expect(d.fields).toEqual({ fullName: 'Ada Example', email: await accountEmail(app, a) });
    const p = await prefill(a);
    expect(p.values.map((v) => v.key).sort()).toEqual(['email', 'fullName']);
  });

  // tl on #415: with no filter on the users read, the second user's draft took the first's.
  it("each user's draft carries their own account's name and email", async () => {
    const { app, a, b } = await boot(ON);
    await setAccount(app, a, 'Ada Example');
    await setAccount(app, b, 'Bea Example');
    expect(await accountEmail(app, b)).not.toBe(await accountEmail(app, a));
    const bDraft = await newDraft(app, b);
    const aDraft = await newDraft(app, a);
    expect(bDraft.fields).toEqual({ fullName: 'Bea Example', email: await accountEmail(app, b) });
    expect(aDraft.fields).toEqual({ fullName: 'Ada Example', email: await accountEmail(app, a) });
  });

  it('a replayed create returns the existing draft and fills nothing again', async () => {
    const { app, a } = await boot(ON);
    await api(a, 'PUT', '/profile', FULL_PROFILE);
    const d = await newDraft(app, a);
    expect((await api(a, 'PATCH', `/submissions/${d.id}`, { fields: {} })).statusCode).toBe(200);
    const again = await api(a, 'POST', `/opportunities/${d.oppId}/submissions`, {
      idempotencyKey: d.idempotencyKey,
      resumeId: d.resumeId,
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().id).toBe(d.id);
    expect(again.json().fields).toEqual({});
  });

  it('a PATCH after create wins over the fill (the start-again carry-over)', async () => {
    const { app, a } = await boot(ON);
    await api(a, 'PUT', '/profile', FULL_PROFILE);
    const d = await newDraft(app, a);
    const carried = { firstName: 'Carried', phone: '+44 20 7946 0000' };
    const res = await api(a, 'PATCH', `/submissions/${d.id}`, { fields: carried });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().fields).toEqual(carried);
  });
});

describe('saving a value to the profile from the draft (#411)', () => {
  async function draftWithProfile(app: FastifyInstance, c: TestClient) {
    expect((await api(c, 'PUT', '/profile', FULL_PROFILE)).statusCode).toBe(200);
    return await newDraft(app, c);
  }

  it('without names to save, an edit changes this application only', async () => {
    const { app, a } = await boot(ON);
    const d = await draftWithProfile(app, a);
    const before = await profileRow(app, a);
    const res = await api(a, 'PATCH', `/submissions/${d.id}`, {
      fields: { ...d.fields, phone: '+1 555 0123', firstName: 'Janie' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await profileRow(app, a)).toEqual(before);
  });

  it('with names to save, writes the draft and the profile, columns and details alike', async () => {
    const { app, a } = await boot(ON);
    const d = await draftWithProfile(app, a);
    const fields = {
      ...d.fields,
      phone: '+1 555 0123',
      workAuthorization: 'Citizen',
      firstName: 'Janie',
      linkedinUrl: 'https://www.linkedin.com/in/janie',
      location: 'Not saved',
    };
    const res = await api(a, 'PATCH', `/submissions/${d.id}`, {
      fields,
      saveToProfile: ['phone', 'workAuthorization', 'firstName', 'linkedinUrl'],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().fields).toEqual(fields);
    const row = await profileRow(app, a);
    expect(row).toMatchObject({
      phone: '+1 555 0123',
      workAuth: 'Citizen',
      location: 'Springfield',
      applicationDetails: {
        firstName: 'Janie',
        lastName: 'Doe',
        websiteUrl: 'https://jane.example',
        linkedinUrl: 'https://www.linkedin.com/in/janie',
      },
    });
  });

  it('saving the values already stored on the draft needs no fields in the request', async () => {
    const { app, a } = await boot(ON);
    const d = await newDraft(app, a);
    await api(a, 'PATCH', `/submissions/${d.id}`, { fields: { lastName: 'Stored' } });
    const res = await api(a, 'PATCH', `/submissions/${d.id}`, { saveToProfile: ['lastName'] });
    expect(res.statusCode, res.body).toBe(200);
    expect((await profileRow(app, a))?.applicationDetails).toEqual({ lastName: 'Stored' });
  });

  it('saving a field the draft leaves empty removes it from the profile', async () => {
    const { app, a } = await boot(ON);
    const d = await draftWithProfile(app, a);
    const rest = Object.fromEntries(
      Object.entries(d.fields).filter(([k]) => k !== 'phone' && k !== 'websiteUrl'),
    );
    const res = await api(a, 'PATCH', `/submissions/${d.id}`, {
      // A link field is never stored empty on a draft: removed, it is absent.
      fields: rest,
      saveToProfile: ['phone', 'websiteUrl'],
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = await profileRow(app, a);
    expect(row?.phone).toBeNull();
    expect(row?.applicationDetails).toEqual({ firstName: 'Jane', lastName: 'Doe' });
  });

  it.each([
    ['a name that is not a detail field', { saveToProfile: ['nickname'] }, 422],
    [
      'a value the profile refuses (an email the profile cannot hold)',
      { fields: { email: 'jané@example.com' }, saveToProfile: ['email'] },
      422,
    ],
    [
      'a value the profile refuses (a full name over 200 characters)',
      { fields: { fullName: 'N'.repeat(201) }, saveToProfile: ['fullName'] },
      422,
    ],
    [
      'a location over 200 characters, which PUT /profile refuses too',
      { fields: { location: `${'x'.repeat(198)}😀😀😀` }, saveToProfile: ['location'] },
      422,
    ],
    [
      'a value the draft refuses',
      { fields: { linkedinUrl: 'linkedin.com/in/x' }, saveToProfile: ['linkedinUrl'] },
      422,
    ],
  ])(
    '%s refuses the whole request: neither the draft nor the profile changes',
    async (_, body, status) => {
      const { app, a } = await boot(ON);
      const d = await draftWithProfile(app, a);
      const draftBefore = await app.db
        .select()
        .from(applicationSubmissions)
        .where(eq(applicationSubmissions.id, d.id))
        .get();
      const profileBefore = await profileRow(app, a);
      const res = await api(a, 'PATCH', `/submissions/${d.id}`, body);
      expect(res.statusCode, res.body).toBe(status);
      expect(res.body).not.toContain('jané');
      expect(
        await app.db
          .select()
          .from(applicationSubmissions)
          .where(eq(applicationSubmissions.id, d.id))
          .get(),
      ).toEqual(draftBefore);
      expect(await profileRow(app, a)).toEqual(profileBefore);
    },
  );

  // The save counts length as PUT /profile does (Zod's max(): code points), so what one
  // accepts the other accepts (tl and qa on #415).
  it('a value saved from an application is one PUT /profile then accepts, and the reverse', async () => {
    const { app, a } = await boot(ON);
    const d = await newDraft(app, a);
    const location = `${'x'.repeat(197)}😀😀😀`; // 200 code points, 203 UTF-16 units
    const saved = await api(a, 'PATCH', `/submissions/${d.id}`, {
      fields: { location },
      saveToProfile: ['location'],
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await profileRow(app, a))?.location).toBe(location);
    // What Settings does next: PUT back exactly what GET returned.
    const got = (await api(a, 'GET', '/profile')).json();
    expect(got.location).toBe(location);
    const put = await api(a, 'PUT', '/profile', {
      location: got.location,
      applicationDetails: got.applicationDetails,
    });
    expect(put.statusCode, put.body).toBe(200);
    expect((await api(a, 'PUT', '/profile', { location: `${location}x` })).statusCode).toBe(400);
  });

  it("names to save only ever write the caller's own profile", async () => {
    const { app, a, b } = await boot(ON);
    await api(b, 'PUT', '/profile', FULL_PROFILE);
    const bBefore = await profileRow(app, b);
    const d = await newDraft(app, a);
    await api(a, 'PATCH', `/submissions/${d.id}`, {
      fields: { phone: '+1 555 0177' },
      saveToProfile: ['phone'],
    });
    expect(await profileRow(app, b)).toEqual(bBefore);
    expect((await profileRow(app, a))?.phone).toBe('+1 555 0177');
    // And another user's attempt is not found, so nothing is saved through it.
    const res = await api(b, 'PATCH', `/submissions/${d.id}`, {
      fields: { phone: '+1 555 0188' },
      saveToProfile: ['phone'],
    });
    expect(res.statusCode).toBe(404);
    expect(await profileRow(app, b)).toEqual(bBefore);
  });
});

describe('/profile carries the application details (#411)', () => {
  it('GET and PUT carry them, and a PUT without them leaves them as they were', async () => {
    const { app, a } = await boot();
    const put = await api(a, 'PUT', '/profile', FULL_PROFILE);
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().applicationDetails).toEqual(FULL_PROFILE.applicationDetails);
    const withoutDetails = Object.fromEntries(
      Object.entries(FULL_PROFILE).filter(([k]) => k !== 'applicationDetails'),
    );
    const again = await api(a, 'PUT', '/profile', { ...withoutDetails, phone: '+1 555 0111' });
    expect(again.statusCode, again.body).toBe(200);
    expect((await api(a, 'GET', '/profile')).json()).toMatchObject({
      phone: '+1 555 0111',
      applicationDetails: FULL_PROFILE.applicationDetails,
    });
    expect((await profileRow(app, a))?.applicationDetails).toEqual(FULL_PROFILE.applicationDetails);
  });

  it('a PUT with empty details clears them, and an empty value is dropped', async () => {
    const { app, a } = await boot();
    await api(a, 'PUT', '/profile', FULL_PROFILE);
    const res = await api(a, 'PUT', '/profile', {
      applicationDetails: { firstName: 'Jane', lastName: '  ' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await profileRow(app, a))?.applicationDetails).toEqual({ firstName: 'Jane' });
  });

  it.each([
    ['a key outside the list', { nickname: 'J' }],
    ['a key that lives in a column', { phone: '+1 555 0100' }],
    ['a value that fails the checks', { linkedinUrl: 'linkedin.com/in/x' }],
    ['a key outside the list with an empty value', { nickname: '' }],
  ])('refuses %s, changing nothing', async (_, applicationDetails) => {
    const { app, a } = await boot();
    await api(a, 'PUT', '/profile', FULL_PROFILE);
    const before = await profileRow(app, a);
    const res = await api(a, 'PUT', '/profile', { ...FULL_PROFILE, applicationDetails });
    expect(res.statusCode).toBe(400);
    expect(await profileRow(app, a)).toEqual(before);
  });
});

describe('the audit record of a profile change names the fields, never the values (#411)', () => {
  const records = async (app: FastifyInstance, c: TestClient) =>
    await app.db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.userId, c.userId), eq(auditLog.event, 'profile.updated')))
      .all();

  it('from Settings and from an application, only when something changed', async () => {
    const { app, a } = await boot(ON);
    await api(a, 'PUT', '/profile', FULL_PROFILE);
    await api(a, 'PUT', '/profile', FULL_PROFILE); // the same again: nothing changed
    const d = await newDraft(app, a);
    await api(a, 'PATCH', `/submissions/${d.id}`, {
      fields: { ...d.fields, phone: '+1 555 0123', firstName: 'Janie' },
      saveToProfile: ['phone', 'firstName', 'lastName'],
    });
    const got = await records(app, a);
    expect(got.map((r) => r.detail)).toEqual([
      {
        via: 'settings',
        changed: [
          'fullName',
          'email',
          'phone',
          'location',
          'workAuth',
          'links',
          'applicationDetails.firstName',
          'applicationDetails.lastName',
          'applicationDetails.websiteUrl',
        ],
      },
      // lastName was saved unchanged, so it is not named.
      { via: 'application', changed: ['phone', 'applicationDetails.firstName'] },
    ]);
    const text = JSON.stringify(got);
    for (const value of ['Jane', '555', 'jane@example.com', 'Springfield', 'Janie']) {
      expect(text).not.toContain(value);
    }
  });
});

describe('a profile saved with the same values again records and writes nothing (#411)', () => {
  // Postgres jsonb stores an object's keys in its own order (shorter keys first), so a stored link
  // reads back as { url, label } while a client sends { label, url }: still the same value. CI's
  // Postgres leg caught a spurious "links changed" record; this reproduces it on either engine.
  it('the same links in another key order are not a change', async () => {
    const { app, a } = await boot();
    const links = [{ label: 'GitHub', url: 'https://github.com/jane-doe-example' }];
    expect((await api(a, 'PUT', '/profile', { fullName: 'Jane Doe', links })).statusCode).toBe(200);
    await app.db
      .update(profiles)
      .set({ links: [{ url: links[0]!.url, label: links[0]!.label }] })
      .where(eq(profiles.userId, a.userId))
      .run();
    const before = await profileRow(app, a);
    const again = await api(a, 'PUT', '/profile', { fullName: 'Jane Doe', links });
    expect(again.statusCode, again.body).toBe(200);
    expect((await profileRow(app, a))?.updatedAt).toBe(before?.updatedAt);
    const recorded = await app.db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.userId, a.userId), eq(auditLog.event, 'profile.updated')))
      .all();
    expect(recorded).toHaveLength(1);
  });
});

describe('the read route follows the assisted apply switch (#411, tl)', () => {
  it('answers 404 with assisted apply off, as the submission routes do', async () => {
    const { a } = await boot();
    const res = await api(a, 'GET', '/profile/application-details');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'feature_unavailable' } });
  });
});

describe('no route the extension can reach is added (#411)', () => {
  it('a device token cannot read the details or save to the profile', async () => {
    const { app, a } = await boot(ON);
    const minted = await a.request({
      method: 'POST',
      url: '/api/v1/device-tokens',
      payload: { name: 'Chrome', scopes: ['apply:assist'], password: PASSWORD },
    });
    expect(minted.statusCode, minted.body).toBe(201);
    const bearer = { authorization: `Bearer ${minted.json().token as string}` };
    const d = await newDraft(app, a);
    const read = await app.inject({
      method: 'GET',
      url: '/api/v1/profile/application-details',
      headers: bearer,
    });
    expect(read.statusCode).toBe(401);
    const save = await app.inject({
      method: 'PATCH',
      url: `/api/v1/submissions/${d.id}`,
      headers: bearer,
      payload: { fields: { phone: '+1 555 0100' }, saveToProfile: ['phone'] },
    });
    expect([401, 403]).toContain(save.statusCode);
    expect((await profileRow(app, a))?.phone ?? null).toBeNull();
  });
});
