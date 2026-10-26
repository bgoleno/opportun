// Scope-lock hotspots with two transactions genuinely open at once (iteration 4 Task 13, the
// Wave 1 carry-over). races.test.ts holds its callers at points BEFORE their transactions, so
// on SQLite the write gate alone passes those tests. Here the first caller parks INSIDE its
// transaction, after its scope lock and check (the `.locked` race points), and the second
// must not get past its own lock until the first commits: on Postgres only the advisory lock
// (lockScope) can hold it, so removing a lockScope fails these tests there. The same tests
// run on SQLite, where the gate holds the second transaction at BEGIN.
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { readRrConfig, RR_SECRET_LABEL, writeRrConfig } from '../src/adapters/reactiveResume';
import { GOOGLE_TOKENS_LABEL, readTokens, writeTokens } from '../src/lib/google';
import { findOrCreateCompany } from '../src/repos/companies';
import { activatePrompt, createPromptVersion, listPromptVersions } from '../src/repos/prompts';
import { useApi } from './api';
import { bool, queryAll } from './db';
import { testApp } from './helpers';
import { heldApart } from './race';

const boot = useApi();

describe('scope locks hold two open transactions apart', () => {
  const opened: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((app) => app.close()));
  });

  it("registration: the second first-user registration waits, then sees the first's admin", async () => {
    const { app } = await testApp();
    opened.push(app);
    const register = (email: string) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: { email, password: 'correct horse battery', displayName: email },
      });
    const [one, two] = await heldApart(
      'auth.register.locked',
      () => register('one@example.com'),
      () => register('two@example.com'),
    );
    expect([one.statusCode, two.statusCode]).toEqual([201, 403]);
    const rows = await queryAll<{ is_admin: unknown }>(app, 'SELECT is_admin FROM users');
    expect(rows.map((r) => bool(r.is_admin))).toEqual([true]);
  });

  it('company find-or-create: one company, both callers get it', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    const [first, second] = await heldApart(
      'companies.findOrCreate.locked',
      () => findOrCreateCompany(app.db, ctx, 'Initech'),
      () => findOrCreateCompany(app.db, ctx, 'initech '),
    );
    expect(second.id).toBe(first.id);
    expect(
      await queryAll(
        app,
        "SELECT id FROM companies WHERE user_id = ? AND lower(name) = 'initech'",
        a.userId,
      ),
    ).toHaveLength(1);
  });

  it('prompt edits: two versions numbered apart', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    const [one, two] = await heldApart(
      'prompts.create.locked',
      () => createPromptVersion(app.db, ctx, 'comms.classify', 'body one'),
      () => createPromptVersion(app.db, ctx, 'comms.classify', 'body two'),
    );
    expect(two.version).toBe(one.version + 1);
    const mine = (await listPromptVersions(app.db, ctx, 'comms.classify')).filter(
      (v) => !v.isSystem,
    );
    expect(mine).toHaveLength(2);
  });

  it('prompt activations: exactly one active afterwards, the later one', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    const one = await createPromptVersion(app.db, ctx, 'comms.classify', 'body one');
    const two = await createPromptVersion(app.db, ctx, 'comms.classify', 'body two');
    await heldApart(
      'prompts.activate.locked',
      () => activatePrompt(app.db, ctx, one.id),
      () => activatePrompt(app.db, ctx, two.id),
    );
    const active = await queryAll<{ id: string }>(
      app,
      "SELECT id FROM prompts WHERE user_id = ? AND task_key = 'comms.classify' AND is_active",
      a.userId,
    );
    expect(active).toEqual([{ id: two.id }]);
  });

  it('Reactive Resume saves: one key row, paired with the later address', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    await heldApart(
      'rr.config.locked',
      () => writeRrConfig(app.db, ctx, 'https://one.example.org', 'key-one'),
      () => writeRrConfig(app.db, ctx, 'https://two.example.org', 'key-two'),
    );
    const keys = await queryAll(
      app,
      'SELECT id FROM secrets WHERE user_id = ? AND label = ?',
      a.userId,
      RR_SECRET_LABEL,
    );
    expect(keys).toHaveLength(1);
    expect(await readRrConfig(app.db, ctx)).toEqual({
      baseUrl: 'https://two.example.org',
      apiKey: 'key-two',
    });
  });

  it('Google token writes: exactly one row, the later one', async () => {
    const { app, a } = await boot();
    const ctx = { userId: a.userId, isAdmin: false };
    const tokens = (refreshToken: string) => ({
      accessToken: `a-${refreshToken}`,
      refreshToken,
      expiryDate: null,
      scopes: ['https://www.googleapis.com/auth/documents'],
    });
    await heldApart(
      'google.replaceSecret.locked',
      () => writeTokens(app.db, ctx, tokens('r-one')),
      () => writeTokens(app.db, ctx, tokens('r-two')),
    );
    const rows = await queryAll(
      app,
      'SELECT id FROM secrets WHERE user_id = ? AND label = ?',
      a.userId,
      GOOGLE_TOKENS_LABEL,
    );
    expect(rows).toHaveLength(1);
    expect((await readTokens(app.db, ctx))?.refreshToken).toBe('r-two');
  });
});
