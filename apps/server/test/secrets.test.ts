import { randomBytes } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { getSecretValue, open, putSecret, seal } from '../src/lib/secretBox';
import { captureLogs, testApp, type TestAppOptions } from './helpers';
import { exec, queryAll, queryOne } from './db';

const PLAINTEXT = 'sk-test-PLAINTEXT-4f9c2e1d7a';
const SESSION = 'opportun_session';
const CSRF = 'opportun_csrf';

describe('seal / open', () => {
  const key = randomBytes(32);

  it('round-trips with AES-256-GCM, base64 fields, a 12 byte iv and key version 1', () => {
    const sealed = seal(key, PLAINTEXT);
    expect(sealed.keyVersion).toBe(1);
    expect(Buffer.from(sealed.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(sealed.tag, 'base64')).toHaveLength(16);
    expect(sealed.ciphertext).not.toContain(PLAINTEXT);
    expect(Buffer.from(sealed.ciphertext, 'base64').toString('utf8')).not.toContain('PLAINTEXT');
    expect(open(key, sealed)).toBe(PLAINTEXT);
  });

  it('uses a fresh random iv per seal', () => {
    const a = seal(key, PLAINTEXT);
    const b = seal(key, PLAINTEXT);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('round-trips unicode and empty-ish values', () => {
    expect(open(key, seal(key, 'päss \u{1F511}'))).toBe('päss \u{1F511}');
    expect(open(key, seal(key, ' '))).toBe(' ');
  });

  it('throws on a tampered tag', () => {
    const sealed = seal(key, PLAINTEXT);
    const tag = Buffer.from(sealed.tag, 'base64');
    tag[0] = (tag[0] ?? 0) ^ 0xff;
    expect(() => open(key, { ...sealed, tag: tag.toString('base64') })).toThrow();
  });

  it('throws on tampered ciphertext', () => {
    const sealed = seal(key, PLAINTEXT);
    const ct = Buffer.from(sealed.ciphertext, 'base64');
    ct[0] = (ct[0] ?? 0) ^ 0x01;
    expect(() => open(key, { ...sealed, ciphertext: ct.toString('base64') })).toThrow();
  });

  it('fails to open with the wrong master key', () => {
    const sealed = seal(key, PLAINTEXT);
    expect(() => open(randomBytes(32), sealed)).toThrow();
  });

  it('rejects an unknown key version and a truncated tag', () => {
    const sealed = seal(key, PLAINTEXT);
    expect(() => open(key, { ...sealed, keyVersion: 2 })).toThrow(/key version/);
    const short = Buffer.from(sealed.tag, 'base64').subarray(0, 4).toString('base64');
    expect(() => open(key, { ...sealed, tag: short })).toThrow();
  });

  it('rejects a master key that is not 32 bytes', () => {
    expect(() => seal(randomBytes(16), PLAINTEXT)).toThrow(/32 bytes/);
  });
});

interface Client {
  userId: string;
  session: string;
  csrf: string;
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function cookieValue(res: LightMyRequestResponse, name: string): string {
  const c = (res.cookies as { name: string; value: string }[]).find((x) => x.name === name);
  return c?.value ?? '';
}

async function boot(opts: TestAppOptions = {}, logLevel = 'silent'): Promise<FastifyInstance> {
  ({ app } = await testApp({ logLevel }, opts));
  return app;
}

async function register(a: FastifyInstance, email: string): Promise<Client> {
  const res = await a.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: 'correct horse battery', displayName: email },
  });
  expect(res.statusCode).toBe(201);
  return {
    userId: res.json().user.id,
    session: cookieValue(res, SESSION),
    csrf: cookieValue(res, CSRF),
  };
}

async function twoUsers(a: FastifyInstance): Promise<{ ada: Client; bob: Client }> {
  const ada = await register(a, 'ada@example.com');
  await exec(a, `UPDATE settings SET value = 'true' WHERE key = 'registration_open'`);
  const bob = await register(a, 'bob@example.com');
  return { ada, bob };
}

function call(
  a: FastifyInstance,
  c: Client | null,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return a.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    cookies: c === null ? {} : { [SESSION]: c.session, [CSRF]: c.csrf },
    headers: c === null ? {} : { 'x-csrf-token': c.csrf },
  });
}

describe('putSecret / getSecretValue', () => {
  it('stores ciphertext only and decrypts for the owning user', async () => {
    const a = await boot();
    const { ada, bob } = await twoUsers(a);
    const ctx = { userId: ada.userId, isAdmin: true };
    const { id } = await putSecret(a.db, ctx, 'ai_api_key', 'OpenAI', PLAINTEXT);

    const row = (await queryOne(a, 'SELECT * FROM secrets WHERE id = ?', id)) as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({
      user_id: ada.userId,
      kind: 'ai_api_key',
      label: 'OpenAI',
      key_version: 1,
    });
    expect(JSON.stringify(row)).not.toContain(PLAINTEXT);

    expect(await getSecretValue(a.db, ctx, id)).toBe(PLAINTEXT);
    await expect(
      getSecretValue(a.db, { userId: bob.userId, isAdmin: false }, id),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('cannot be decrypted by an app with a different master key', async () => {
    const a = await boot();
    const ada = await register(a, 'ada@example.com');
    const ctx = { userId: ada.userId, isAdmin: true };
    const { id } = await putSecret(a.db, ctx, 'ai_api_key', 'OpenAI', PLAINTEXT);
    const row = (await queryOne(a, 'SELECT * FROM secrets WHERE id = ?', id)) as {
      ciphertext: string;
      iv: string;
      tag: string;
      key_version: number;
    };
    const sealed = {
      ciphertext: row.ciphertext,
      iv: row.iv,
      tag: row.tag,
      keyVersion: row.key_version,
    };
    expect(open(a.config.masterKey, sealed)).toBe(PLAINTEXT);
    expect(() => open(randomBytes(32), sealed)).toThrow();
  });
});

describe('/api/v1/secrets', () => {
  it('creates, lists and deletes without ever returning, logging or auditing the value', async () => {
    const logs = captureLogs();
    const a = await boot({ logStream: logs }, 'trace');
    const { ada } = await twoUsers(a);

    const created = await call(a, ada, 'POST', '/api/v1/secrets', {
      kind: 'ai_api_key',
      label: 'OpenAI',
      value: PLAINTEXT,
    });
    expect(created.statusCode).toBe(201);
    const { validation, ...body } = created.json();
    expect(body).toEqual({
      id: expect.any(String),
      kind: 'ai_api_key',
      label: 'OpenAI',
      displayName: null,
      expiresAt: null,
      createdAt: expect.any(Number),
    });
    // Validated on add; a label that is not a provider id fails without any network call.
    expect(validation).toMatchObject({ ok: false, error: 'key is not linked to a provider' });

    const list = await call(a, ada, 'GET', '/api/v1/secrets');
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ items: [body], total: 1 });
    for (const item of list.json().items) {
      expect(Object.keys(item).sort()).toEqual([
        'createdAt',
        'displayName',
        'expiresAt',
        'id',
        'kind',
        'label',
      ]);
    }

    const del = await call(a, ada, 'DELETE', `/api/v1/secrets/${body.id}`);
    expect(del.statusCode).toBe(204);
    expect((await call(a, ada, 'DELETE', `/api/v1/secrets/${body.id}`)).statusCode).toBe(404);
    expect((await call(a, ada, 'GET', '/api/v1/secrets')).json()).toEqual({ items: [], total: 0 });

    for (const res of [created, list, del]) expect(res.body).not.toContain(PLAINTEXT);
    const auditRows = (await queryAll(
      a,
      `SELECT event, detail FROM audit_log WHERE event LIKE 'secret.%' ORDER BY id`,
    )) as { event: string; detail: string }[];
    expect(auditRows.map((r) => r.event)).toEqual(['secret.created', 'secret.deleted']);
    expect(JSON.stringify(auditRows)).not.toContain(PLAINTEXT);
    expect(logs.lines.length).toBeGreaterThan(0);
    expect(logs.text()).not.toContain(PLAINTEXT);
  });

  it('lists only the caller own secrets and refuses to delete another user secret', async () => {
    const a = await boot();
    const { ada, bob } = await twoUsers(a);
    const created = await call(a, ada, 'POST', '/api/v1/secrets', {
      kind: 'oauth_token',
      label: 'Gmail',
      value: PLAINTEXT,
    });
    const { id } = created.json();
    expect((await call(a, bob, 'GET', '/api/v1/secrets')).json()).toEqual({ items: [], total: 0 });
    expect((await call(a, bob, 'DELETE', `/api/v1/secrets/${id}`)).statusCode).toBe(404);
    expect((await call(a, ada, 'GET', '/api/v1/secrets')).json().total).toBe(1);
  });

  it('requires a session and validates the body without echoing the value', async () => {
    const a = await boot();
    const { ada } = await twoUsers(a);
    expect((await call(a, null, 'GET', '/api/v1/secrets')).statusCode).toBe(401);
    const bad = await call(a, ada, 'POST', '/api/v1/secrets', {
      kind: 'not_a_kind',
      label: 'x',
      value: PLAINTEXT,
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('validation');
    expect(bad.body).not.toContain(PLAINTEXT);
    const empty = await call(a, ada, 'POST', '/api/v1/secrets', {
      kind: 'ai_api_key',
      label: 'x',
      value: '',
    });
    expect(empty.statusCode).toBe(400);
  });
});
