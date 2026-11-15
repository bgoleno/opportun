// Assisted apply on the demo, bound to the visitor whose data it is
// (https://github.com/bgoleno/opportun/issues/545, slice 2 of #542; tl and sec's design note,
// point 5, and sec's amendment). Demo accounts are shared logins: two people signed in to one
// account hold different sessions, so different actors. Either may read the account's drafts, as
// the owner chose; only the visitor who started an attempt may act on it, and only their device
// token is given it. This slice is also the one that turns assisted apply on for the demo, so the
// demo is never on without the binding (sec on #544).
import { newId } from '@opportun/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { DEMO_USERS } from '../src/cli/seedDemoFixture';
import { submissionsEnabled } from '../src/config';
import {
  applicationSubmissions,
  attachments,
  deviceTokens,
  opportunities,
  resumes,
} from '../src/db/schema';
import { removeIfUnreferenced } from '../src/jobs/attachmentSweep';
import { createDeviceToken } from '../src/lib/deviceTokens';
import { setRaceHook } from '../src/lib/racePoints';
import { createOpportunity } from '../src/repos/opportunities';
import { insertResume } from '../src/repos/resumes';
import { useApi } from './api';
import { PASSWORD, sharedDemoUser, signIn, type TestClient } from './isolation';
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
/** The shared account bootShared signs in as: a second session signs in to the same one. */
const A_EMAIL = DEMO_USERS[1]!.email;

async function readyOpportunity(app: FastifyInstance, c: TestClient): Promise<string> {
  const opp = await createOpportunity(app.db, ctxOf(c), {
    companyName: 'Example Corp',
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

async function draftOf(app: FastifyInstance, c: TestClient): Promise<string> {
  const res = await api(c, 'POST', `/opportunities/${await readyOpportunity(app, c)}/submissions`, {
    idempotencyKey: crypto.randomUUID(),
  });
  expect(res.statusCode, res.body).toBe(201);
  const id = res.json<{ id: string }>().id;
  expect(
    (await api(c, 'PATCH', `/submissions/${id}`, { fields: { fullName: 'Jane Visitor' } }))
      .statusCode,
  ).toBe(200);
  return id;
}

async function review(c: TestClient, id: string) {
  const current = await api(c, 'GET', `/submissions/${id}`);
  return await api(c, 'POST', `/submissions/${id}/review`, {
    reviewDigest: current.json<{ reviewDigest: string }>().reviewDigest,
    acknowledged: true,
  });
}

async function handedOff(app: FastifyInstance, c: TestClient) {
  const id = await draftOf(app, c);
  expect((await review(c, id)).statusCode).toBe(200);
  expect((await api(c, 'POST', `/submissions/${id}/handoff`, {})).statusCode).toBe(200);
  const row = (await app.db
    .select()
    .from(applicationSubmissions)
    .where(eq(applicationSubmissions.id, id))
    .get())!;
  return { id, destinationUrl: row.destinationUrl };
}

const mint = (c: TestClient, scopes: string[] = ['apply:assist']) =>
  api(c, 'POST', '/device-tokens', { name: 'Chrome', scopes, password: PASSWORD });

async function tokenOf(c: TestClient): Promise<string> {
  const res = await mint(c);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ token: string }>().token;
}

const device = (
  app: FastifyInstance,
  token: string,
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
) =>
  app.inject({
    method,
    url: `/api/v1/connector/apply${url}`,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  });

const notYours = { code: 'not_your_application' };

describe('the switch is on for the demo, with the binding (#545)', () => {
  it('submissionsEnabled follows OPPORTUN_SUBMISSIONS alone, the demo included', () => {
    expect(submissionsEnabled({ submissions: true })).toBe(true);
    expect(submissionsEnabled({ submissions: false })).toBe(false);
  });

  it('a demo deployment has the submission routes and mints apply:assist; OPPORTUN_SUBMISSIONS=0 still turns them off', async () => {
    const on = await bootShared();
    const created = await api(
      on.a,
      'POST',
      `/opportunities/${await readyOpportunity(on.app, on.a)}/submissions`,
      { idempotencyKey: crypto.randomUUID() },
    );
    expect(created.statusCode, created.body).toBe(201);
    expect((await mint(on.a)).statusCode).toBe(201);

    const off = await boot({ demo: true, submissions: false });
    const res = await api(
      off.a,
      'POST',
      `/opportunities/${await readyOpportunity(off.app, off.a)}/submissions`,
      { idempotencyKey: crypto.randomUUID() },
    );
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('feature_unavailable');
  });
});

describe('only the visitor who started an attempt may act on it (#545, criterion 4)', () => {
  it('a second session on the same account can read the draft, and gets 403 on every change but cancel', async () => {
    const { app, a } = await bootShared();
    const id = await draftOf(app, a);
    const other = await signIn(app, A_EMAIL);
    const read = await api(other, 'GET', `/submissions/${id}`);
    expect(read.statusCode).toBe(200);
    expect(read.json<{ fields: unknown }>().fields).toEqual({ fullName: 'Jane Visitor' });
    const digest = read.json<{ reviewDigest: string }>().reviewDigest;
    for (const [method, url, payload] of [
      ['PATCH', `/submissions/${id}`, { fields: { fullName: 'Someone Else' } }],
      ['POST', `/submissions/${id}/review`, { reviewDigest: digest, acknowledged: true }],
      ['POST', `/submissions/${id}/handoff`, {}],
      // The routes a narrower URL check could miss (tl on #566).
      ['POST', `/submissions/${id}/attest`, {}],
      ['POST', `/submissions/${id}/outcome`, {}],
      ['POST', `/submissions/${id}/unlink-confirmation`, {}],
    ] as const) {
      const res = await api(other, method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json<{ error: unknown }>().error, url).toMatchObject(notYours);
    }
    // Unchanged, and still its own visitor's to carry on.
    expect((await api(a, 'GET', `/submissions/${id}`)).json<{ fields: unknown }>().fields).toEqual({
      fullName: 'Jane Visitor',
    });
    expect((await review(a, id)).statusCode).toBe(200);
  });

  it('a new sign-in is a new visitor: the old session’s drafts are not its to change', async () => {
    const { app, a } = await bootShared();
    const id = await draftOf(app, a);
    const again = await signIn(app, A_EMAIL);
    expect((await api(again, 'GET', `/submissions/${id}`)).statusCode).toBe(200);
    const patched = await api(again, 'PATCH', `/submissions/${id}`, {
      fields: { fullName: 'X Y' },
    });
    expect(patched.statusCode).toBe(403);
    expect(patched.json<{ error: unknown }>().error).toMatchObject(notYours);
  });

  // tl on #566: a draft never expires and holds its opportunity's one live slot, so a draft whose
  // session ended (a sign-out, a cleared cookie, a password change by anyone on the account) would
  // block that opportunity for the whole account until the reset. Any session may cancel it.
  it('a stranded draft is cancelled by a new session, and a new attempt on the opportunity then succeeds', async () => {
    const { app, a } = await bootShared();
    const oppId = await readyOpportunity(app, a);
    const started = await api(a, 'POST', `/opportunities/${oppId}/submissions`, {
      idempotencyKey: crypto.randomUUID(),
    });
    expect(started.statusCode, started.body).toBe(201);
    const id = started.json<{ id: string }>().id;
    // The visitor's session ends; the next one finds the slot taken.
    const again = await signIn(app, A_EMAIL);
    const blocked = await api(again, 'POST', `/opportunities/${oppId}/submissions`, {
      idempotencyKey: crypto.randomUUID(),
    });
    expect(blocked.statusCode).toBe(409);
    const cancelled = await api(again, 'POST', `/submissions/${id}/cancel`, {});
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json<{ status: string }>().status).toBe('abandoned');
    const fresh = await api(again, 'POST', `/opportunities/${oppId}/submissions`, {
      idempotencyKey: crypto.randomUUID(),
    });
    expect(fresh.statusCode, fresh.body).toBe(201);
    // The new attempt is the new session's own.
    expect(
      (
        await api(again, 'PATCH', `/submissions/${fresh.json<{ id: string }>().id}`, {
          fields: { fullName: 'Jane Visitor' },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('another live session’s draft can be cancelled by a second session, but not patched', async () => {
    const { app, a } = await bootShared();
    const id = await draftOf(app, a);
    const other = await signIn(app, A_EMAIL);
    expect(
      (await api(other, 'PATCH', `/submissions/${id}`, { fields: { fullName: 'X Y' } })).statusCode,
    ).toBe(403);
    const cancelled = await api(other, 'POST', `/submissions/${id}/cancel`, {});
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect((await api(a, 'GET', `/submissions/${id}`)).json<{ status: string }>().status).toBe(
      'abandoned',
    );
  });

  it('an attempt from before the binding (no actor) can be read or cancelled, and changed by no one', async () => {
    const { app, a } = await bootShared();
    const id = await draftOf(app, a);
    await app.db
      .update(applicationSubmissions)
      .set({ actor: null })
      .where(eq(applicationSubmissions.id, id))
      .run();
    expect((await api(a, 'GET', `/submissions/${id}`)).statusCode).toBe(200);
    expect(
      (await api(a, 'PATCH', `/submissions/${id}`, { fields: { fullName: 'X Y' } })).statusCode,
    ).toBe(403);
    expect((await api(a, 'POST', `/submissions/${id}/cancel`, {})).statusCode).toBe(200);
  });

  it('off the demo there is no binding: a second session of the user acts as before', async () => {
    const { app, a } = await boot({ submissions: true });
    const oppId = await readyOpportunity(app, a);
    // A draft needs a resume off the demo; one is made the way the other suites make it.
    const r = await insertResume(app.db, ctxOf(a), {
      kind: 'base',
      title: 'Mine',
      store: 'local_file',
      docRef: `resumes/${newId()}.txt`,
      opportunityId: null,
      parentResumeId: null,
    });
    await app.db.update(resumes).set({ status: 'final' }).where(eq(resumes.id, r.id)).run();
    const draft = await api(a, 'POST', `/opportunities/${oppId}/submissions`, {
      idempotencyKey: crypto.randomUUID(),
      resumeId: r.id,
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const id = draft.json<{ id: string }>().id;
    const row = await app.db
      .select()
      .from(applicationSubmissions)
      .where(eq(applicationSubmissions.id, id))
      .get();
    expect(row?.actor).toBeNull();
    const other = await signIn(app, 'isolation-a@example.com');
    expect(
      (await api(other, 'PATCH', `/submissions/${id}`, { fields: { fullName: 'X Y' } })).statusCode,
    ).toBe(200);
  });
});

describe('a demo device token is given only its own visitor’s attempts (#545, criterion 4)', () => {
  it('the other visitor’s token gets no attempt from /current, a 404 for /snapshot and for the confirmation, and no confirmable', async () => {
    const { app, a } = await bootShared();
    const { id, destinationUrl } = await handedOff(app, a);
    const mine = await tokenOf(a);
    const other = await signIn(app, A_EMAIL);
    const theirs = await tokenOf(other);

    const own = await device(
      app,
      mine,
      'GET',
      `/current?url=${encodeURIComponent(destinationUrl)}`,
    );
    expect(own.json<{ attempt: { id: string } | null }>().attempt?.id).toBe(id);

    const cur = await device(
      app,
      theirs,
      'GET',
      `/current?url=${encodeURIComponent(destinationUrl)}`,
    );
    expect(cur.statusCode).toBe(200);
    expect(cur.json()).toEqual({ attempt: null, reason: 'no_matching_attempt' });
    expect((await device(app, theirs, 'GET', `/${id}/snapshot`)).statusCode).toBe(404);

    // Said submitted by its own visitor, then looked up and confirmed from the other's token.
    const attest = await api(a, 'POST', `/submissions/${id}/attest`, { moveToApplied: false });
    expect(attest.statusCode, attest.body).toBe(200);
    const confirmable = await device(
      app,
      theirs,
      'GET',
      `/confirmable?url=${encodeURIComponent(destinationUrl)}`,
    );
    expect(confirmable.json<{ attempt: unknown }>().attempt).toBeNull();
    const confirm = await device(app, theirs, 'POST', `/${id}/confirmation`, {
      url: destinationUrl,
      title: 'Thank you for applying',
      text: 'Thank you for applying. We received your application.',
    });
    expect(confirm.statusCode).toBe(404);
  });

  it('a token from before the binding (no actor) is given nothing, even an attempt with no actor either', async () => {
    const { app, a } = await bootShared();
    const { id, destinationUrl } = await handedOff(app, a);
    const { token } = await createDeviceToken(app.db, ctxOf(a), {
      name: 'old',
      scopes: ['apply:assist'],
    });
    const ask = () =>
      device(app, token, 'GET', `/current?url=${encodeURIComponent(destinationUrl)}`);
    expect((await ask()).json()).toEqual({ attempt: null, reason: 'no_matching_attempt' });
    // No actor on either side is nobody's, not a match.
    await app.db
      .update(applicationSubmissions)
      .set({ actor: null })
      .where(eq(applicationSubmissions.id, id))
      .run();
    expect((await ask()).json()).toEqual({ attempt: null, reason: 'no_matching_attempt' });
  });

  it('a token minted on the demo records its visitor', async () => {
    const { app, a } = await bootShared();
    await tokenOf(a);
    const [row] = await app.db
      .select()
      .from(deviceTokens)
      .where(eq(deviceTokens.userId, a.userId))
      .all();
    expect(row?.actor).toMatch(/^demo-user1\.[0-9a-f]{10}$/);
  });
});

// The owner's decision on #545 (decision 132), against sec's proposal to refuse it: the Mail
// connector stays on the demo. A visitor's own mail in a shared account is visible to the other
// visitors on it, behind the same warning as assisted apply (#546).
describe('device token scopes on the demo (the owner’s decision on #545)', () => {
  it('mail:push, capture:push and apply:assist all mint', async () => {
    const { a } = await bootShared();
    for (const scopes of [
      ['mail:push'],
      ['capture:push'],
      ['apply:assist'],
      ['apply:assist', 'capture:push', 'mail:push'],
    ]) {
      expect((await mint(a, scopes)).statusCode, scopes.join(',')).toBe(201);
    }
  });
});

describe('the reset’s file removal re-checks the references right before the unlink (tl’s E3 on #550)', () => {
  it('a row that starts referencing the file just before the unlink keeps it', async () => {
    const { app, a } = await bootShared();
    const file = await app.storage.writeAttachment(Buffer.from(`late reference ${newId()}`));
    setRaceHook(async (point) => {
      if (point !== 'attachments.removeNow.beforeDelete') return;
      await app.db
        .insert(attachments)
        .values({
          id: newId(),
          userId: a.userId,
          opportunityId: null,
          filename: 'late.pdf',
          mime: 'application/pdf',
          bytes: file.bytes,
          sha256: file.sha256,
          storedPath: file.storedPath,
          createdAt: Date.now(),
        })
        .run();
    });
    try {
      expect(await removeIfUnreferenced(app.db, app.storage, file.storedPath)).toBe(false);
    } finally {
      setRaceHook(undefined);
    }
    expect(await app.storage.attachmentMtime(file.storedPath)).toBeDefined();
  });
});
