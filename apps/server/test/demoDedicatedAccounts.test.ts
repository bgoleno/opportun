// A demo server's two kinds of account (decision 133; tl and sec on
// https://github.com/bgoleno/opportun/issues/542#issuecomment-6884754511). The seed's pinned
// accounts are shared logins, and the demo's protections exist for them. An account the owner
// makes for one person on a demo server is that person's, and behaves as on any instance
// (#545, criteria a and c). The dedicated user here is registered directly (tl); how the owner
// makes one, and how the nightly reset leaves it alone, is #563's (test/demoDedicatedAccount.test.ts).
import { newId } from '@opportun/core';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { DEMO_USERS } from '../src/lib/demo/fixture';
import {
  applicationSubmissions,
  deviceTokens,
  opportunities,
  profiles,
  resumes,
} from '../src/db/schema';
import { createDeviceToken } from '../src/lib/deviceTokens';
import { createOpportunity } from '../src/repos/opportunities';
import { insertResume } from '../src/repos/resumes';
import { useApi } from './api';
import { PASSWORD, sharedDemoUser, signIn, type TestClient } from './isolation';
import { api, requisition } from './submissionFixtures';

const boot = useApi();
const ON_THE_DEMO = { demo: true, submissions: true } as const;
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });
/** On a demo test app, the registered users (a, b) are not pinned: they are dedicated accounts. */
const DEDICATED_EMAIL = 'isolation-a@example.com';

async function readyOpportunity(app: FastifyInstance, c: TestClient): Promise<string> {
  const opp = await createOpportunity(app.db, ctxOf(c), {
    companyName: 'Example Corp',
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

async function ownResume(app: FastifyInstance, c: TestClient): Promise<string> {
  const r = await insertResume(app.db, ctxOf(c), {
    kind: 'base',
    title: 'My Resume',
    store: 'local_file',
    docRef: `resumes/${newId()}.txt`,
    opportunityId: null,
    parentResumeId: null,
  });
  await app.db.update(resumes).set({ status: 'final' }).where(eq(resumes.id, r.id)).run();
  return r.id;
}

const mint = (c: TestClient, scopes: string[] = ['apply:assist']) =>
  api(c, 'POST', '/device-tokens', { name: 'Chrome', scopes, password: PASSWORD });

const activeTokens = (app: FastifyInstance, c: TestClient) =>
  app.db
    .select()
    .from(deviceTokens)
    .where(and(eq(deviceTokens.userId, c.userId), isNull(deviceTokens.revokedAt)))
    .all();

describe('a dedicated account on a demo server behaves as on any instance (#545, criterion a)', () => {
  it('a prefilled draft, its own resume, saveToProfile and the profile’s details, with no actor and no binding', async () => {
    const { app, a } = await boot(ON_THE_DEMO);
    const now = Date.now();
    await app.db
      .insert(profiles)
      .values({ userId: a.userId, fullName: 'Jane Dedicated', createdAt: now, updatedAt: now })
      .run();
    // Its own resume is accepted, and the draft is prefilled from its profile.
    const resumeId = await ownResume(app, a);
    const created = await api(
      a,
      'POST',
      `/opportunities/${await readyOpportunity(app, a)}/submissions`,
      {
        idempotencyKey: crypto.randomUUID(),
        resumeId,
      },
    );
    expect(created.statusCode, created.body).toBe(201);
    const draft = created.json<{ id: string; fields: Record<string, string> }>();
    expect(draft.fields).toMatchObject({ fullName: 'Jane Dedicated' });
    // saveToProfile is allowed.
    const saved = await api(a, 'PATCH', `/submissions/${draft.id}`, {
      fields: { ...draft.fields, phone: '+1 555 0100' },
      saveToProfile: ['phone'],
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const profile = await app.db.select().from(profiles).where(eq(profiles.userId, a.userId)).get();
    expect(profile?.phone).toBe('+1 555 0100');
    // The profile's application details are offered.
    const details = await api(a, 'GET', '/profile/application-details');
    expect(details.json<{ values: { key: string }[] }>().values.map((v) => v.key)).toContain(
      'fullName',
    );
    // No visitor recorded, and a second session of the same person acts on the draft.
    const row = await app.db
      .select()
      .from(applicationSubmissions)
      .where(eq(applicationSubmissions.id, draft.id))
      .get();
    expect(row?.actor).toBeNull();
    const other = await signIn(app, DEDICATED_EMAIL);
    const patched = await api(other, 'PATCH', `/submissions/${draft.id}`, {
      fields: { ...draft.fields, fullName: 'Jane D.' },
    });
    expect(patched.statusCode, patched.body).toBe(200);
  });

  it('no fixture backstop: the demo’s own names are this person’s to use', async () => {
    const { app, a } = await boot(ON_THE_DEMO);
    const created = await api(
      a,
      'POST',
      `/opportunities/${await readyOpportunity(app, a)}/submissions`,
      {
        idempotencyKey: crypto.randomUUID(),
        resumeId: await ownResume(app, a),
      },
    );
    const id = created.json<{ id: string }>().id;
    await app.jobs.drain();
    await api(a, 'PATCH', `/submissions/${id}`, {
      fields: { fullName: DEMO_USERS[1]!.displayName },
    });
    const current = await api(a, 'GET', `/submissions/${id}`);
    const reviewed = await api(a, 'POST', `/submissions/${id}/review`, {
      reviewDigest: current.json<{ reviewDigest: string }>().reviewDigest,
      acknowledged: true,
    });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
  });

  it('no token cap, and its tokens record no visitor', async () => {
    const { app, a } = await boot(ON_THE_DEMO);
    for (let i = 0; i < 20; i++) {
      await createDeviceToken(app.db, ctxOf(a), { name: `t${i}`, scopes: ['capture:push'] });
    }
    const res = await mint(a);
    expect(res.statusCode, res.body).toBe(201);
    expect(await activeTokens(app, a)).toHaveLength(21);
    const minted = await app.db
      .select()
      .from(deviceTokens)
      .where(eq(deviceTokens.id, res.json<{ id: string }>().id))
      .get();
    expect(minted?.actor).toBeNull();
  });
});

describe('the shared accounts’ settings do what they say (#545, criterion c)', () => {
  it('OPPORTUN_DEMO_TOKEN_CAP=3: a shared account’s 4th mint revokes its oldest', async () => {
    const { app } = await boot({ ...ON_THE_DEMO, demoTokenCap: 3 });
    const shared = await sharedDemoUser(app, 2);
    for (let i = 0; i < 3; i++) expect((await mint(shared)).statusCode).toBe(201);
    expect((await mint(shared)).statusCode).toBe(201);
    expect(await activeTokens(app, shared)).toHaveLength(3);
  });

  it('OPPORTUN_DEMO_TOKEN_CAP=0: no cap on a shared account either', async () => {
    const { app } = await boot({ ...ON_THE_DEMO, demoTokenCap: 0 });
    const shared = await sharedDemoUser(app, 2);
    for (let i = 0; i < 21; i++) {
      await createDeviceToken(app.db, ctxOf(shared), { name: `t${i}`, scopes: ['capture:push'] });
    }
    expect((await mint(shared)).statusCode).toBe(201);
    expect(await activeTokens(app, shared)).toHaveLength(22);
  });

  it('OPPORTUN_DEMO_SHARED_ASSISTED_APPLY=0: off for the shared accounts only, as if the feature were off', async () => {
    const { app, a } = await boot({ ...ON_THE_DEMO, demoSharedAssistedApply: false });
    const shared = await sharedDemoUser(app, 2);
    // A token minted while it was on still reaches nothing.
    const { token } = await createDeviceToken(app.db, ctxOf(shared), {
      name: 'old',
      scopes: ['apply:assist'],
    });
    const draft = await api(
      shared,
      'POST',
      `/opportunities/${await readyOpportunity(app, shared)}/submissions`,
      {
        idempotencyKey: crypto.randomUUID(),
      },
    );
    expect(draft.statusCode).toBe(404);
    expect(draft.json<{ error: { code: string } }>().error.code).toBe('feature_unavailable');
    expect((await api(shared, 'GET', '/profile/application-details')).statusCode).toBe(404);
    const scope = await mint(shared);
    expect(scope.json<{ error: { code: string } }>().error.code).toBe('scope_unavailable');
    const current = await app.inject({
      method: 'GET',
      url: '/api/v1/connector/apply/current?url=https%3A%2F%2Fboards.greenhouse.io%2Fx%2Fjobs%2F1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(current.statusCode).toBe(404);
    // A dedicated account on the same server is unaffected.
    const own = await api(
      a,
      'POST',
      `/opportunities/${await readyOpportunity(app, a)}/submissions`,
      {
        idempotencyKey: crypto.randomUUID(),
        resumeId: await ownResume(app, a),
      },
    );
    expect(own.statusCode, own.body).toBe(201);
    expect((await mint(a)).statusCode).toBe(201);
  });

  it('with the defaults, a shared account has assisted apply and the cap of 20', async () => {
    const { app } = await boot(ON_THE_DEMO);
    const shared = await sharedDemoUser(app, 2);
    const draft = await api(
      shared,
      'POST',
      `/opportunities/${await readyOpportunity(app, shared)}/submissions`,
      {
        idempotencyKey: crypto.randomUUID(),
      },
    );
    expect(draft.statusCode, draft.body).toBe(201);
    for (let i = 0; i < 20; i++) {
      await createDeviceToken(app.db, ctxOf(shared), { name: `t${i}`, scopes: ['capture:push'] });
    }
    expect((await mint(shared)).statusCode).toBe(201);
    expect(await activeTokens(app, shared)).toHaveLength(20);
  });
});
