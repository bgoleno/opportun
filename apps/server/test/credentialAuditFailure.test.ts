// https://github.com/bgoleno/opportun/issues/802 (the sweep in #801, for #779): a device-token,
// stored-secret, Google or OAuth-provider credential change wrote its audit row after the change
// had committed, so a failed audit write left the change standing with no record of it. Each
// creation and edit below writes its audit row in its own transaction: a failed write changes
// nothing. A removal (a revoke, a delete, a disconnect) is the other way round (sec on #815, as a
// logout is): it commits first and is recorded after, so a failed write never leaves a credential
// working that its owner removed.
//
// The failure is injected at the audit step itself: the real insert runs, through whatever
// executor the step passed, and then the step throws. A row left behind afterwards would mean the
// write ran outside the step's transaction.
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditLog, deviceTokens, secrets, settings } from '../src/db/schema';
import { readClientCreds, readTokens } from '../src/lib/google';
import { useApi } from './api';
import { connectGoogle, fakeGoogle, type FakeGoogle } from './fakeGoogle';
import { PASSWORD, type TestClient } from './isolation';

/** The audit event whose write fails, or null for none. */
let failing: string | null = null;

vi.mock('../src/lib/audit', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/audit')>();
  return {
    ...real,
    audit: async (...args: Parameters<typeof real.audit>) => {
      await real.audit(...args);
      if (args[1] === failing) throw new Error('audit write failed');
    },
  };
});

afterEach(() => {
  failing = null;
});

let google: FakeGoogle;
const boot = useApi(() => {
  google = fakeGoogle();
  return { build: { google } };
});
const ctxOf = (c: TestClient) => ({ userId: c.userId, isAdmin: false });

/** How many audit rows of `event` there are. */
const rowsOf = async (app: FastifyInstance, event: string) =>
  (await app.db.select().from(auditLog).where(eq(auditLog.event, event)).all()).length;

/** Runs `step` with `event`'s audit write failing; it must answer 500. */
async function failing500(event: string, step: () => ReturnType<TestClient['request']>) {
  failing = event;
  const res = await step();
  failing = null;
  expect(res.statusCode, res.body).toBe(500);
  return res;
}

/** As failing500, for a creation or an edit: its audit row was rolled back with it (tl). */
async function rolledBack(
  app: FastifyInstance,
  event: string,
  step: () => ReturnType<TestClient['request']>,
) {
  const before = await rowsOf(app, event);
  const res = await failing500(event, step);
  expect(await rowsOf(app, event)).toBe(before);
  return res;
}

const tokensOf = async (app: FastifyInstance, userId: string) =>
  await app.db.select().from(deviceTokens).where(eq(deviceTokens.userId, userId)).all();

async function mint(c: TestClient, name = 'laptop') {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/device-tokens',
    payload: { name, scopes: ['mail:push'], password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}

describe('device tokens: the audit row commits with the change (#802)', () => {
  it('a mint whose audit write fails creates no token', async () => {
    const { app, a } = await boot();
    await rolledBack(app, 'device_token.created', () =>
      a.request({
        method: 'POST',
        url: '/api/v1/device-tokens',
        payload: { name: 'laptop', scopes: ['mail:push'], password: PASSWORD },
      }),
    );
    expect(await tokensOf(app, a.userId)).toEqual([]);
  });

  it('a rename whose audit write fails keeps the old name', async () => {
    const { app, a } = await boot();
    const id = await mint(a, 'laptop');
    await rolledBack(app, 'device_token.renamed', () =>
      a.request({ method: 'PATCH', url: `/api/v1/device-tokens/${id}`, payload: { name: 'x' } }),
    );
    expect((await tokensOf(app, a.userId))[0]!.name).toBe('laptop');
  });

  it('a revoke whose audit write fails still revokes the token (sec on #815)', async () => {
    const { app, a } = await boot();
    const id = await mint(a);
    await failing500('device_token.revoked', () =>
      a.request({ method: 'DELETE', url: `/api/v1/device-tokens/${id}` }),
    );
    expect((await tokensOf(app, a.userId))[0]!.revokedAt).not.toBeNull();
    // Only the call that revoked it records it: a second revoke writes nothing.
    const rows = await rowsOf(app, 'device_token.revoked');
    expect(
      (await a.request({ method: 'DELETE', url: `/api/v1/device-tokens/${id}` })).statusCode,
    ).toBe(204);
    expect(await rowsOf(app, 'device_token.revoked')).toBe(rows);
  });
});

const secretsOf = async (app: FastifyInstance, userId: string) =>
  await app.db
    .select({ id: secrets.id, label: secrets.label, displayName: secrets.displayName })
    .from(secrets)
    .where(eq(secrets.userId, userId))
    .all();

async function storeKey(c: TestClient) {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/secrets',
    payload: { kind: 'oauth_token', label: 'Some service', value: 'a stored value 802' },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}

describe('stored secrets: the audit row commits with the change (#802)', () => {
  it('a secret whose audit write fails is not stored', async () => {
    const { app, a } = await boot();
    await rolledBack(app, 'secret.created', () =>
      a.request({
        method: 'POST',
        url: '/api/v1/secrets',
        payload: { kind: 'oauth_token', label: 'Some service', value: 'a stored value 802' },
      }),
    );
    expect(await secretsOf(app, a.userId)).toEqual([]);
  });

  it('an edit whose audit write fails keeps the old details', async () => {
    const { app, a } = await boot();
    const id = await storeKey(a);
    const before = await secretsOf(app, a.userId);
    await rolledBack(app, 'secret.updated', () =>
      a.request({
        method: 'PATCH',
        url: `/api/v1/secrets/${id}`,
        payload: { displayName: 'renamed' },
      }),
    );
    expect(await secretsOf(app, a.userId)).toEqual(before);
  });

  it('a delete whose audit write fails still deletes the secret (sec on #815)', async () => {
    const { app, a } = await boot();
    const id = await storeKey(a);
    await failing500('secret.deleted', () =>
      a.request({ method: 'DELETE', url: `/api/v1/secrets/${id}` }),
    );
    expect(await secretsOf(app, a.userId)).toEqual([]);
  });
});

describe('the Google integration: the audit row commits with the change (#802)', () => {
  it('a client whose audit write fails is not stored', async () => {
    const { app, a } = await boot();
    await rolledBack(app, 'google.client_configured', () =>
      a.request({
        method: 'POST',
        url: '/api/v1/integrations/google/client',
        payload: {
          clientId: 'client-id.apps.googleusercontent.com',
          clientSecret: 'GOCSPX-client-secret-value',
        },
      }),
    );
    expect(await readClientCreds(app.db, ctxOf(a))).toBeUndefined();
  });

  it('a connection whose audit write fails stores no tokens', async () => {
    const { app, a } = await boot();
    const saved = await a.request({
      method: 'POST',
      url: '/api/v1/integrations/google/client',
      payload: {
        clientId: 'client-id.apps.googleusercontent.com',
        clientSecret: 'GOCSPX-client-secret-value',
      },
    });
    expect(saved.statusCode).toBe(200);
    const connect = await a.request({
      method: 'GET',
      url: '/api/v1/integrations/google/connect?scopes=docs',
    });
    const state = new URL(connect.json().authUrl as string).searchParams.get('state') ?? '';
    await rolledBack(app, 'google.connected', () =>
      a.request({
        method: 'GET',
        url: `/api/v1/integrations/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      }),
    );
    expect(await readTokens(app.db, ctxOf(a))).toBeUndefined();
  });

  it('a disconnect whose audit write fails still removes the client and tokens (sec on #815)', async () => {
    const { app, a } = await boot();
    await connectGoogle(a, 'docs', google);
    await failing500('google.disconnected', () =>
      a.request({ method: 'DELETE', url: '/api/v1/integrations/google' }),
    );
    expect(await readTokens(app.db, ctxOf(a))).toBeUndefined();
    expect(await readClientCreds(app.db, ctxOf(a))).toBeUndefined();
  });

  it('a connection whose audit write fails revokes the grant Google issued (sec, tl on #815)', async () => {
    const { app, a } = await boot();
    const saved = await a.request({
      method: 'POST',
      url: '/api/v1/integrations/google/client',
      payload: {
        clientId: 'client-id.apps.googleusercontent.com',
        clientSecret: 'GOCSPX-client-secret-value',
      },
    });
    expect(saved.statusCode).toBe(200);
    const connect = await a.request({
      method: 'GET',
      url: '/api/v1/integrations/google/connect?scopes=docs',
    });
    const state = new URL(connect.json().authUrl as string).searchParams.get('state') ?? '';
    expect(google.revoked).toEqual([]);
    await failing500('google.connected', () =>
      a.request({
        method: 'GET',
        url: `/api/v1/integrations/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      }),
    );
    expect(await readTokens(app.db, ctxOf(a))).toBeUndefined();
    expect(google.revoked).toHaveLength(1);
  });
});

const providerRows = async (app: FastifyInstance) =>
  (await app.db.select({ key: settings.key }).from(settings).all()).filter((r) =>
    r.key.startsWith('oauth_provider:'),
  );

const configure = (a: TestClient) =>
  a.request({
    method: 'PUT',
    url: '/api/v1/admin/oauth-providers/github',
    payload: { clientId: 'github-client-id', clientSecret: 'a client secret', password: PASSWORD },
  });

describe("the admin's OAuth providers: the audit row commits with the change (#802)", () => {
  it('a provider whose audit write fails is not configured', async () => {
    const { app, a } = await boot();
    expect(await providerRows(app)).toEqual([]);
    await rolledBack(app, 'admin.oauth_provider_configured', () => configure(a));
    expect(await providerRows(app)).toEqual([]);
    // And with the audit write working, the same request stores it.
    expect((await configure(a)).statusCode).toBe(200);
    expect(await providerRows(app)).toHaveLength(1);
  });

  it('a removal whose audit write fails still removes the provider (sec on #815)', async () => {
    const { app, a } = await boot();
    expect((await configure(a)).statusCode).toBe(200);
    expect(await providerRows(app)).toHaveLength(1);
    await failing500('admin.oauth_provider_removed', () =>
      a.request({
        method: 'DELETE',
        url: '/api/v1/admin/oauth-providers/github',
        payload: { password: PASSWORD },
      }),
    );
    expect(await providerRows(app)).toEqual([]);
  });

  it('an import of the integration client whose audit write fails stores nothing (tl on #815)', async () => {
    const { app, a } = await boot();
    const saved = await a.request({
      method: 'POST',
      url: '/api/v1/integrations/google/client',
      payload: {
        clientId: 'client-id.apps.googleusercontent.com',
        clientSecret: 'GOCSPX-client-secret-value',
      },
    });
    expect(saved.statusCode).toBe(200);
    await rolledBack(app, 'admin.oauth_provider_configured', () =>
      a.request({
        method: 'POST',
        url: '/api/v1/admin/oauth-providers/google/import',
        payload: { password: PASSWORD },
      }),
    );
    expect(await providerRows(app)).toEqual([]);
  });
});
