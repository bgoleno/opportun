// Check-then-act hotspots (ADR-4 inventory, iteration 4 Task 5). Each racing test fires
// concurrent callers and uses a race point (test/race.ts) to hold them until every one has
// done its reads and checks and none has written: the worst interleaving, produced on
// purpose. The invariant must hold for exactly-one outcomes. On SQLite the write gate
// serializes transactions anyway; these same tests are the Postgres oracle in Task 13. Each
// compare-and-set statement also gets a unit test of its own (the second CAS finds no row).
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Db } from '../src/db/client';
import { jobs, sessions, users } from '../src/db/schema';
import { registerJob, unregisterJob } from '../src/jobs/registry';
import { enqueue, reviveDeadJob, runDueJobs } from '../src/jobs/runner';
import { createDeviceToken, revokeDeviceToken } from '../src/lib/deviceTokens';
import {
  GOOGLE_TOKENS_LABEL,
  readTokens,
  storeRefreshedTokens,
  writeTokens,
} from '../src/lib/google';
import { hashPassword, pepperSet } from '../src/lib/passwords';
import { decryptSecret, encryptSecret } from '../src/lib/secretBox';
import { generateTotpSecret, totpCode } from '../src/lib/totp';
import {
  checkSecondFactor,
  claimPendingToken,
  claimTotpStep,
  createPendingToken,
  generateRecoveryCodes,
  hashRecoveryCode,
  redeemPendingToken,
  replaceRecoveryCodes,
} from '../src/lib/twoFactor';
import { ingestInbound } from '../src/jobs/mailIngest';
import { upsertInbound } from '../src/repos/communications';
import { findOrCreateCompany } from '../src/repos/companies';
import { activatePrompt, createPromptVersion, listPromptVersions } from '../src/repos/prompts';
import { readRrConfig, RR_SECRET_LABEL, writeRrConfig } from '../src/adapters/reactiveResume';
import { useApi } from './api';
import { registerTwoUsers, type TestClient } from './isolation';
import { testApp } from './helpers';
import { exec, queryAll } from './db';
import { holdAt, pauseAt } from './race';

const boot = useApi();

/** Turns on 2FA for `userId` directly in the database; returns the plaintext secret. */
async function enableTwoFactor(db: Db, userId: string): Promise<string> {
  const secret = generateTotpSecret();
  await db
    .update(users)
    .set({ totpSecret: encryptSecret(db, secret), totpEnabled: true, totpLastStep: null })
    .where(eq(users.id, userId))
    .run();
  return secret;
}

/** Gives `userId` fresh recovery codes (2FA must be on); returns the plaintext codes. */
async function setRecoveryCodes(db: Db, userId: string): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await db
    .update(users)
    .set({ totpRecovery: codes.map(hashRecoveryCode) })
    .where(eq(users.id, userId))
    .run();
  return codes;
}

async function recoveryHashes(db: Db, userId: string): Promise<string[] | null> {
  const row = await db
    .select({ recovery: users.totpRecovery })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  return row?.recovery ?? null;
}

async function lastStep(db: Db, userId: string): Promise<number | null> {
  const row = await db
    .select({ step: users.totpLastStep })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  return row?.step ?? null;
}

describe('hotspot 1: TOTP step replay', () => {
  it('claimTotpStep is a compare-and-set: a step claims once, never backwards', async () => {
    const { app, a } = await boot();
    await enableTwoFactor(app.db, a.userId);
    expect(await claimTotpStep(app.db, a.userId, 100)).toBe(true);
    expect(await claimTotpStep(app.db, a.userId, 100)).toBe(false);
    expect(await claimTotpStep(app.db, a.userId, 99)).toBe(false);
    expect(await claimTotpStep(app.db, a.userId, 101)).toBe(true);
    expect(await lastStep(app.db, a.userId)).toBe(101);
    // Never for a user without enabled 2FA.
    expect(await claimTotpStep(app.db, (await boot()).b.userId, 500)).toBe(false);
  });

  it('two concurrent verifies of one code: exactly one is accepted', async () => {
    const { app, a } = await boot();
    const secret = await enableTwoFactor(app.db, a.userId);
    const now = Date.now();
    const code = totpCode(secret, now);
    const barrier = holdAt('twoFactor.totp', 2);
    const results = await Promise.all([
      checkSecondFactor(app.db, a.userId, { code }, now),
      checkSecondFactor(app.db, a.userId, { code }, now),
    ]);
    expect(barrier.arrived()).toBe(2);
    expect(results.sort()).toEqual(['totp', null].sort());
    // The accepted step is recorded, so a third try is a replay too.
    expect(await checkSecondFactor(app.db, a.userId, { code }, now)).toBeNull();
  });
});

describe('hotspot 2: recovery code double spend', () => {
  it('replaceRecoveryCodes is a compare-and-set on the previous list', async () => {
    const { app, a } = await boot();
    await enableTwoFactor(app.db, a.userId);
    const codes = await setRecoveryCodes(app.db, a.userId);
    const before = codes.map(hashRecoveryCode);
    const after = before.slice(1);
    expect(await replaceRecoveryCodes(app.db, a.userId, before, after)).toBe(true);
    // A writer still holding the old list loses.
    expect(await replaceRecoveryCodes(app.db, a.userId, before, before.slice(2))).toBe(false);
    expect(await recoveryHashes(app.db, a.userId)).toEqual(after);
  });

  it('two concurrent spends of one code: exactly one is accepted', async () => {
    const { app, a } = await boot();
    await enableTwoFactor(app.db, a.userId);
    const [code] = await setRecoveryCodes(app.db, a.userId);
    const barrier = holdAt('twoFactor.recovery', 2);
    const results = await Promise.all([
      checkSecondFactor(app.db, a.userId, { recoveryCode: code! }),
      checkSecondFactor(app.db, a.userId, { recoveryCode: code! }),
    ]);
    expect(barrier.arrived()).toBe(2);
    expect(results.sort()).toEqual(['recovery', null].sort());
    expect(await recoveryHashes(app.db, a.userId)).toHaveLength(9);
  });

  it('two concurrent spends of two different codes: both are accepted, both are gone', async () => {
    const { app, a } = await boot();
    await enableTwoFactor(app.db, a.userId);
    const [first, second] = await setRecoveryCodes(app.db, a.userId);
    const barrier = holdAt('twoFactor.recovery', 2);
    const results = await Promise.all([
      checkSecondFactor(app.db, a.userId, { recoveryCode: first! }),
      checkSecondFactor(app.db, a.userId, { recoveryCode: second! }),
    ]);
    expect(barrier.arrived()).toBe(2);
    // The loser of the compare-and-set re-reads and retries: no valid code is refused, and
    // neither spend overwrites the other.
    expect(results).toEqual(['recovery', 'recovery']);
    const left = await recoveryHashes(app.db, a.userId);
    expect(left).toHaveLength(8);
    expect(left).not.toContain(hashRecoveryCode(first!));
    expect(left).not.toContain(hashRecoveryCode(second!));
  });
});

describe('hotspot 3: pending 2FA token double redeem', () => {
  const tokenId = (token: string) => createHash('sha256').update(token).digest('hex');

  it('claimPendingToken is a compare-and-set: a live token is claimed once', async () => {
    const { app, a } = await boot();
    const token = await createPendingToken(app.db, a.userId, {});
    const now = Date.now();
    expect(await claimPendingToken(app.db, tokenId(token), now)).toEqual({
      userId: a.userId,
      failedAttempts: 0,
    });
    expect(await claimPendingToken(app.db, tokenId(token), now)).toBeUndefined();
    // Never an expired token, never a session row.
    const late = await createPendingToken(app.db, a.userId, {});
    expect(await claimPendingToken(app.db, tokenId(late), now + 60 * 60 * 1000)).toBeUndefined();
  });

  it('two concurrent verifies on one token: exactly one signs in, the other reads token_used', async () => {
    const { app, a } = await boot();
    const secret = await enableTwoFactor(app.db, a.userId);
    const [recovery] = await setRecoveryCodes(app.db, a.userId);
    const token = await createPendingToken(app.db, a.userId, {});
    const now = Date.now();
    const barrier = holdAt('twoFactor.pendingClaim', 2);
    // Different valid factors, so only the token claim can stop the second one.
    const results = await Promise.all([
      redeemPendingToken(app.db, token, { code: totpCode(secret, now) }, now),
      redeemPendingToken(app.db, token, { recoveryCode: recovery! }, now),
    ]);
    expect(barrier.arrived()).toBe(2);
    const wins = results.filter((r) => r.ok);
    expect(wins).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, code: 'token_used' }]);
    // The loser never spent its factor.
    const spentRecovery = wins[0]!.ok && wins[0]!.method === 'recovery';
    expect(await recoveryHashes(app.db, a.userId)).toHaveLength(spentRecovery ? 9 : 10);
    expect(await lastStep(app.db, a.userId)).toBe(spentRecovery ? null : Math.floor(now / 30_000));
    const row = await app.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, tokenId(token)))
      .get();
    expect(row?.usedAt).toBe(now);
  });
});

describe('hotspot 4: job double claim', () => {
  afterEach(() => unregisterJob('test.race'));

  it('two runners draining one queue of 50 jobs run every job exactly once', async () => {
    const { app } = await boot();
    const runs = new Map<string, number>();
    registerJob({
      kind: 'test.race',
      payloadSchema: z.object({ n: z.number() }),
      maxAttempts: 1,
      run: async (_db, payload) => {
        const key = String(payload.n);
        runs.set(key, (runs.get(key) ?? 0) + 1);
        // Yield, so the two runners interleave claim by claim.
        await new Promise((r) => setTimeout(r, 0));
      },
    });
    for (let n = 0; n < 50; n++) await enqueue(app.db, 'test.race', { n });
    // Both runners' first claims are issued together, then they keep racing.
    const barrier = holdAt('jobs.claim', 2);
    const [first, second] = await Promise.all([
      runDueJobs(app.db, { workerId: 'runner-a' }),
      runDueJobs(app.db, { workerId: 'runner-b' }),
    ]);
    expect(barrier.arrived()).toBe(2);
    expect(first + second).toBe(50);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(0);
    expect(runs.size).toBe(50);
    expect([...runs.values()].every((count) => count === 1)).toBe(true);
    const rows = await app.db
      .select({ status: jobs.status, attempts: jobs.attempts })
      .from(jobs)
      .where(eq(jobs.kind, 'test.race'))
      .all();
    expect(rows).toHaveLength(50);
    expect(rows.every((r) => r.status === 'done' && r.attempts === 1)).toBe(true);
  });
});

describe('hotspot 5: enqueue dedupe', () => {
  const insertJob = (app: { db: Db }, id: string, status: string, key: string | null) =>
    exec(
      app,
      `INSERT INTO jobs (id, kind, payload, run_at, attempts, max_attempts, status, dedupe_key, created_at, updated_at)
       VALUES (?, 'test.dedupe', '{}', 0, 0, 1, ?, ?, 0, 0)`,
      id,
      status,
      key,
    );

  it('the partial unique index admits one unfinished job per (kind, dedupe_key)', async () => {
    const { app } = await boot();
    await insertJob(app, 'p1', 'pending', 'k');
    // SQLite: "UNIQUE constraint failed"; Postgres: "duplicate key value violates unique".
    await expect(insertJob(app, 'p2', 'pending', 'k')).rejects.toThrow(/UNIQUE|unique/);
    await expect(insertJob(app, 'r1', 'running', 'k')).rejects.toThrow(/UNIQUE|unique/);
    // Finished jobs, other keys and keyless jobs are unconstrained.
    await insertJob(app, 'd1', 'done', 'k');
    await insertJob(app, 'x1', 'dead', 'k');
    await insertJob(app, 'o1', 'pending', 'other');
    await insertJob(app, 'n1', 'pending', null);
    await insertJob(app, 'n2', 'pending', null);
  });

  it('two concurrent enqueues with one dedupe key: one row, both get its id', async () => {
    const { app } = await boot();
    const barrier = holdAt('jobs.enqueue', 2);
    const [first, second] = await Promise.all([
      enqueue(app.db, 'test.dedupe', {}, { dedupeKey: 'same' }),
      enqueue(app.db, 'test.dedupe', {}, { dedupeKey: 'same' }),
    ]);
    expect(barrier.arrived()).toBe(2);
    expect(second).toBe(first);
    const rows = await queryAll<{ id: string }>(
      app,
      "SELECT id FROM jobs WHERE kind = 'test.dedupe'",
    );
    expect(rows).toEqual([{ id: first }]);
  });

  it('reviving a dead job whose key an unfinished job holds is a 409, not a crash', async () => {
    const { app, a } = await boot();
    await insertJob(app, 'dead-1', 'dead', 'k');
    await insertJob(app, 'live-1', 'pending', 'k');
    await expect(reviveDeadJob(app.db, 'dead-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'already_queued',
    });
    const res = await a.request({ method: 'POST', url: '/api/v1/jobs/dead-1/retry' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('already_queued');
  });
});

describe('hotspot 6: first user becomes admin', () => {
  const opened: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((app) => app.close()));
  });

  it('two concurrent first registrations: exactly one admin, the other refused', async () => {
    const { app } = await testApp();
    opened.push(app);
    const register = (email: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email, password: 'correct horse battery', displayName: email },
      });
    // Both requests have hashed their password and stand at the transaction, neither has
    // counted the users table yet.
    const barrier = holdAt('auth.register', 2);
    const responses = await Promise.all([register('one@example.com'), register('two@example.com')]);
    expect(barrier.arrived()).toBe(2);
    const statuses = responses.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([201, 403]);
    const refused = responses.find((r) => r.statusCode === 403)!;
    expect(refused.json().error.code).toBe('registration_closed');
    const rows = await queryAll<{ is_admin: number | boolean }>(app, 'SELECT is_admin FROM users');
    expect(rows).toHaveLength(1);
    expect(Boolean(rows[0]!.is_admin)).toBe(true);
  });
});

describe('hotspot 7: company find-or-create', () => {
  it('two concurrent find-or-creates of one name (any case): one company, both get it', async () => {
    const { app, a, b } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    const barrier = holdAt('companies.findOrCreate', 2);
    const [first, second] = await Promise.all([
      findOrCreateCompany(app.db, ctx, 'Initech'),
      findOrCreateCompany(app.db, ctx, 'initech '),
    ]);
    expect(barrier.arrived()).toBe(2);
    expect(second.id).toBe(first.id);
    const rows = await queryAll<{ id: string }>(
      app,
      'SELECT id FROM companies WHERE user_id = ? AND lower(name) = ?',
      a.userId,
      'initech',
    );
    expect(rows).toEqual([{ id: first.id }]);
    // Another user's company of the same name is theirs alone.
    const theirs = await findOrCreateCompany(
      app.db,
      { userId: b.userId, isAdmin: false },
      'Initech',
    );
    expect(theirs.id).not.toBe(first.id);
  });
});

describe('hotspot 8: inbound communication upsert', () => {
  const message = (subject: string) => ({
    externalId: 'gmail-msg-1',
    threadKey: 't-1',
    from: 'recruiter@initech.example',
    to: ['me@example.com'],
    subject,
    snippet: 'About the role',
    // Stage 1 reads the text: a body with nothing job-related in it is dropped at ingest, and
    // these tests are about the upsert, not the filter.
    bodyText: 'Are you open to an interview?',
    sentAt: 1_790_000_000_000,
  });

  it('upsertInbound is one statement: insert once, then refresh the same row', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    const first = await upsertInbound(app.db, ctx, 'gmail', message('Hello'));
    expect(first.inserted).toBe(true);
    const again = await upsertInbound(app.db, ctx, 'gmail', message('Hello, updated'));
    expect(again).toEqual({ id: first.id, inserted: false });
    const rows = await queryAll<{ id: string; subject: string }>(
      app,
      'SELECT id, subject FROM communications WHERE user_id = ?',
      a.userId,
    );
    expect(rows).toEqual([{ id: first.id, subject: 'Hello, updated' }]);
  });

  it('two concurrent ingests of one message: one row, inserted once, classified once', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    const barrier = holdAt('mail.ingest', 2);
    const results = await Promise.all([
      ingestInbound(app.db, ctx, app.storage, 'gmail', message('Hello')),
      ingestInbound(app.db, ctx, app.storage, 'gmail', message('Hello')),
    ]);
    expect(barrier.arrived()).toBe(2);
    expect(results[1]!.id).toBe(results[0]!.id);
    expect(results.filter((r) => r.inserted)).toHaveLength(1);
    const rows = await queryAll(app, 'SELECT id FROM communications WHERE user_id = ?', a.userId);
    expect(rows).toHaveLength(1);
    const classify = await queryAll(
      app,
      "SELECT id FROM jobs WHERE kind = 'comms.classify' AND status IN ('pending', 'running')",
    );
    expect(classify).toHaveLength(1);
    const indexed = await queryAll(
      app,
      "SELECT entity_id FROM search_index WHERE entity_kind = 'communication' AND user_id = ?",
      a.userId,
    );
    expect(indexed).toEqual([{ entity_id: results[0]!.id }]);
  });
});

describe('hotspot 9: prompt versions', () => {
  const TASK = 'comms.classify';

  it('two concurrent edits of one task: two new versions, numbered apart', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    const barrier = holdAt('prompts.create', 2);
    const created = await Promise.all([
      createPromptVersion(app.db, ctx, TASK, 'body one'),
      createPromptVersion(app.db, ctx, TASK, 'body two'),
    ]);
    expect(barrier.arrived()).toBe(2);
    const versions = created.map((v) => v.version).sort((x, y) => x - y);
    expect(versions[1]).toBe(versions[0]! + 1);
    const mine = (await listPromptVersions(app.db, ctx, TASK)).filter((v) => !v.isSystem);
    expect(mine.map((v) => v.version).sort((x, y) => x - y)).toEqual(versions);
  });

  it('two concurrent activations of two versions: exactly one active afterwards', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    const one = await createPromptVersion(app.db, ctx, TASK, 'body one');
    const two = await createPromptVersion(app.db, ctx, TASK, 'body two');
    const barrier = holdAt('prompts.activate', 2);
    const results = await Promise.all([
      activatePrompt(app.db, ctx, one.id),
      activatePrompt(app.db, ctx, two.id),
    ]);
    expect(barrier.arrived()).toBe(2);
    expect(results.map((r) => r.id).sort()).toEqual([one.id, two.id].sort());
    const active = await queryAll<{ id: string }>(
      app,
      'SELECT id FROM prompts WHERE user_id = ? AND task_key = ? AND is_active',
      a.userId,
      TASK,
    );
    expect(active).toHaveLength(1);
    expect([one.id, two.id]).toContain(active[0]!.id);
  });
});

describe('hotspot 10: Reactive Resume vault write', () => {
  it('two concurrent saves: one key row survives, paired with its own address', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    const barrier = holdAt('rr.config', 2);
    await Promise.all([
      writeRrConfig(app.db, ctx, 'https://one.example.org', 'key-one'),
      writeRrConfig(app.db, ctx, 'https://two.example.org', 'key-two'),
    ]);
    expect(barrier.arrived()).toBe(2);
    const keys = await queryAll(
      app,
      'SELECT id FROM secrets WHERE user_id = ? AND label = ?',
      a.userId,
      RR_SECRET_LABEL,
    );
    expect(keys).toHaveLength(1);
    const config = await readRrConfig(app.db, ctx);
    expect([
      { baseUrl: 'https://one.example.org', apiKey: 'key-one' },
      { baseUrl: 'https://two.example.org', apiKey: 'key-two' },
    ]).toContainEqual(config);
  });
});

describe('2FA enroll and activate (review fix 1)', () => {
  const PASSWORD = 'correct horse battery';
  const enroll = (c: TestClient) =>
    c.request({ method: 'POST', url: '/api/v1/auth/2fa/enroll', payload: { password: PASSWORD } });

  it('an enroll that lands between activate verifying the code and writing never locks the user out', async () => {
    const { app, a } = await boot();
    const first = await enroll(a);
    const { secret } = first.json() as { secret: string };
    // Activate verifies a code for `secret`, then is parked before its write.
    const pause = pauseAt('twoFactor.activate');
    const activating = a.request({
      method: 'POST',
      url: '/api/v1/auth/2fa/activate',
      payload: { password: PASSWORD, code: totpCode(secret, Date.now()) },
    });
    await pause.reached;
    // A second enroll (another tab) replaces the pending secret meanwhile.
    const second = await enroll(a);
    expect(second.statusCode).toBe(200);
    const replaced = (second.json() as { secret: string }).secret;
    pause.release();
    const activated = await activating;
    // The verified secret is gone: activating now would enable a secret the user's
    // authenticator does not hold. It must be refused.
    expect(activated.statusCode).toBe(409);
    const row = await app.db.select().from(users).where(eq(users.id, a.userId)).get();
    expect(row?.totpEnabled).toBe(false);
    expect(decryptSecret(app.db, row!.totpSecret!)).toBe(replaced);
  });

  it('a double-submitted activate enables once and hands out one set of recovery codes', async () => {
    const { app, a } = await boot();
    const { secret } = (await enroll(a)).json() as { secret: string };
    const code = totpCode(secret, Date.now());
    const barrier = holdAt('twoFactor.activate', 2);
    const activate = () =>
      a.request({
        method: 'POST',
        url: '/api/v1/auth/2fa/activate',
        payload: { password: PASSWORD, code },
      });
    const responses = await Promise.all([activate(), activate()]);
    expect(barrier.arrived()).toBe(2);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const issued = (
      responses.find((r) => r.statusCode === 200)!.json() as { recoveryCodes: string[] }
    ).recoveryCodes;
    // The stored hashes are the codes the user was shown, not another set.
    expect((await recoveryHashes(app.db, a.userId))?.sort()).toEqual(
      issued.map(hashRecoveryCode).sort(),
    );
  });

  it('an enroll after activation (already enabled) is refused at the write too', async () => {
    const { app, a } = await boot();
    const { secret } = (await enroll(a)).json() as { secret: string };
    // Enroll reads "not enabled", is parked, activate completes, then enroll writes.
    const pause = pauseAt('twoFactor.enroll');
    const enrolling = enroll(a);
    await pause.reached;
    const activated = await a.request({
      method: 'POST',
      url: '/api/v1/auth/2fa/activate',
      payload: { password: PASSWORD, code: totpCode(secret, Date.now()) },
    });
    expect(activated.statusCode).toBe(200);
    pause.release();
    expect((await enrolling).statusCode).toBe(409);
    const row = await app.db.select().from(users).where(eq(users.id, a.userId)).get();
    expect(row?.totpEnabled).toBe(true);
    expect(decryptSecret(app.db, row!.totpSecret!)).toBe(secret);
  });
});

describe('auth writes keyed only on id (review fix 1 sweep)', () => {
  const PASSWORD = 'correct horse battery';
  const login = (app: FastifyInstance, password: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'isolation-a@example.com', password },
    });

  it('a login rehash never writes back a password changed while it was in flight', async () => {
    const { app } = await testApp({ peppers: pepperSet(1, { 1: 'server-pepper-of-length' }) });
    const { a } = await registerTwoUsers(app);
    try {
      // A hash from before the pepper was set: the next login with the password rehashes it.
      await app.db
        .update(users)
        .set({ passwordHash: await hashPassword(PASSWORD) })
        .where(eq(users.id, a.userId))
        .run();
      const pause = pauseAt('auth.loginRehash');
      const loggingIn = login(app, PASSWORD);
      await pause.reached;
      const changed = await a.request({
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: { current: PASSWORD, next: 'a brand new passphrase' },
      });
      expect(changed.statusCode).toBe(204);
      pause.release();
      expect((await loggingIn).statusCode).toBe(200);
      // The change stands: the in-flight login did not put the old password back.
      expect((await login(app, 'a brand new passphrase')).statusCode).toBe(200);
      expect((await login(app, PASSWORD)).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('two password changes proving the same current password: exactly one wins', async () => {
    const { app, a } = await boot();
    const barrier = holdAt('auth.passwordChange', 2);
    const change = (next: string) =>
      a.request({
        method: 'POST',
        url: '/api/v1/auth/password',
        payload: { current: PASSWORD, next },
      });
    const responses = await Promise.all([
      change('first new passphrase'),
      change('second new passphrase'),
    ]);
    expect(barrier.arrived()).toBe(2);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([204, 403]);
    const winner =
      responses[0]!.statusCode === 204 ? 'first new passphrase' : 'second new passphrase';
    expect((await login(app, winner)).statusCode).toBe(200);
  });

  it('a double revoke keeps the first revocation time', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    const { meta } = await createDeviceToken(app.db, ctx, { name: 'mail', scopes: ['mail:push'] });
    const pause = pauseAt('deviceTokens.revoke');
    const late = revokeDeviceToken(app.db, ctx, meta.id);
    await pause.reached;
    const first = await revokeDeviceToken(app.db, ctx, meta.id);
    await new Promise((r) => setTimeout(r, 5));
    pause.release();
    expect((await late).revokedAt).toBe(first.revokedAt);
    const rows = await queryAll<{ revoked_at: number }>(
      app,
      'SELECT revoked_at FROM device_tokens',
    );
    expect(rows).toEqual([{ revoked_at: first.revokedAt }]);
  });

  it('a disable parked after its factor check cannot wipe a 2FA enrolled again meanwhile', async () => {
    const { app, a } = await boot();
    const enrollAndActivate = async () => {
      const { secret } = (
        await a.request({
          method: 'POST',
          url: '/api/v1/auth/2fa/enroll',
          payload: { password: PASSWORD },
        })
      ).json() as { secret: string };
      const res = await a.request({
        method: 'POST',
        url: '/api/v1/auth/2fa/activate',
        payload: { password: PASSWORD, code: totpCode(secret, Date.now()) },
      });
      expect(res.statusCode).toBe(200);
      return { secret, recoveryCodes: (res.json() as { recoveryCodes: string[] }).recoveryCodes };
    };
    const old = await enrollAndActivate();
    const disable = (recoveryCode: string) =>
      a.request({
        method: 'POST',
        url: '/api/v1/auth/2fa/disable',
        payload: { password: PASSWORD, recoveryCode },
      });
    const pause = pauseAt('twoFactor.disable');
    const parked = disable(old.recoveryCodes[0]!);
    await pause.reached;
    expect((await disable(old.recoveryCodes[1]!)).statusCode).toBe(204);
    const fresh = await enrollAndActivate();
    pause.release();
    expect((await parked).statusCode).toBe(409);
    const row = await app.db.select().from(users).where(eq(users.id, a.userId)).get();
    expect(row?.totpEnabled).toBe(true);
    expect(decryptSecret(app.db, row!.totpSecret!)).toBe(fresh.secret);
  });
});

describe('Google vault writes (review fix 3)', () => {
  const tokens = (refreshToken: string, accessToken: string) => ({
    accessToken,
    refreshToken,
    expiryDate: null,
    scopes: ['https://www.googleapis.com/auth/documents'],
  });
  const tokenRows = (app: { db: Db }, userId: string) =>
    queryAll(
      app,
      'SELECT id FROM secrets WHERE user_id = ? AND label = ?',
      userId,
      GOOGLE_TOKENS_LABEL,
    );

  it('two concurrent token writes leave exactly one row (never zero)', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    const barrier = holdAt('google.replaceSecret', 2);
    await Promise.all([
      writeTokens(app.db, ctx, tokens('r-one', 'a-one')),
      writeTokens(app.db, ctx, tokens('r-two', 'a-two')),
    ]);
    expect(barrier.arrived()).toBe(2);
    expect(await tokenRows(app, a.userId)).toHaveLength(1);
    expect(['r-one', 'r-two']).toContain((await readTokens(app.db, ctx))?.refreshToken);
  });

  it('two concurrent refreshes never lose a rotated refresh token', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    await writeTokens(app.db, ctx, tokens('r-old', 'a-old'));
    const barrier = holdAt('google.refresh', 2);
    await Promise.all([
      // Google rotated the refresh token in this one...
      storeRefreshedTokens(app.db, ctx, { access_token: 'a-1', refresh_token: 'r-rotated' }),
      // ...and omitted it in this one (keep the stored value).
      storeRefreshedTokens(app.db, ctx, { access_token: 'a-2' }),
    ]);
    expect(barrier.arrived()).toBe(2);
    expect(await tokenRows(app, a.userId)).toHaveLength(1);
    expect((await readTokens(app.db, ctx))?.refreshToken).toBe('r-rotated');
  });
});
