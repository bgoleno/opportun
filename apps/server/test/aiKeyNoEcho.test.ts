// No message echoes the AI key or any part of it
// (https://github.com/bgoleno/opportun/issues/896). Every value here is made up.
import { AiUnavailableError } from '@opportun/ai';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { secrets, taskRuns } from '../src/db/schema';
import { buildAiDeps } from '../src/lib/ai';
import { validateAndStoreAiKey } from '../src/lib/aiKeyValidate';
import { getSecretValue, putSecret } from '../src/lib/secretBox';
import type { UserCtx } from '../src/repos/base';
import { useApi } from './api';
import { captureLogs } from './helpers';
import type { TestClient } from './isolation';

const logs = captureLogs();
const boot = useApi(() => ({ logStream: logs }));
const ctxOf = (c: TestClient): UserCtx => ({ userId: c.userId, isAdmin: false });

/** Made-up keys that are refused, and every part of them that must not be said. */
const REFUSED: [string, string, string[]][] = [
  [
    'one',
    'zq-madeup-alpha\u4f60bravo-0123',
    ['madeup', 'alpha', 'bravo', '\u4f60', '20320', '0123'],
  ],
  ['two', 'zq-madeup-alpha\nbravo-0123', ['madeup', 'alpha', 'bravo', '0123']],
  ['three', 'zq-madeup-alpha\nbravo-0123\n', ['madeup', 'alpha', 'bravo', '0123']],
  ['four', 'zq-madeup-alpha\u0000bravo-0123', ['madeup', 'alpha', 'bravo', '0123']],
  ['five', ' \n ', []],
];
const GOOD = 'zq-madeup-good-0123';

// The runtime's own header check, with no request: what a provider client would meet.
const fetchMock = vi.fn<typeof fetch>((_input, init) => {
  new Headers(init?.headers);
  return Promise.reject(new Error('network disabled in tests'));
});

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  logs.lines.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function expectNone(text: string, parts: string[]) {
  for (const part of parts) expect(text).not.toContain(part);
}
const save = (c: TestClient, value: string, kind = 'ai_api_key') =>
  c.request({ method: 'POST', url: '/api/v1/secrets', payload: { kind, label: 'openai', value } });
async function stored(app: Awaited<ReturnType<typeof boot>>['app'], c: TestClient) {
  return await app.db
    .select({ id: secrets.id })
    .from(secrets)
    .where(eq(secrets.userId, c.userId))
    .all();
}

it.each(REFUSED)(
  'saving, key %s: refused in plain words, and nothing is stored or sent',
  async (_n, value, parts) => {
    const { app, a } = await boot();
    const res = await save(a, value);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toEqual({
      code: 'invalid_ai_key',
      message:
        'That key cannot be used. Copy the key again from the provider and save it on its own.',
    });
    expectNone(res.body, parts);
    expect(await stored(app, a)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expectNone(logs.lines.join('\n'), parts);
  },
);

it('saving: white space around a key is not part of it', async () => {
  const { app, a } = await boot();
  const res = await save(a, `  ${GOOD}\n`);
  expect(res.statusCode, res.body).toBe(201);
  expect(await getSecretValue(app.db, ctxOf(a), res.json().id as string)).toBe(GOOD);
});

it.each(['zq-madeup-caf\u00e9-0123', 'zq madeup good 0123'])(
  'control: a key a provider could take is saved as it is (%#)',
  async (value) => {
    const { app, a } = await boot();
    const res = await save(a, value);
    expect(res.statusCode, res.body).toBe(201);
    expect(await getSecretValue(app.db, ctxOf(a), res.json().id as string)).toBe(value);
  },
);

it.each(REFUSED)(
  'checking, key %s already stored: not sent, and the result says nothing of it',
  async (_n, value, parts) => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    const { id } = await putSecret(app.db, ctx, 'ai_api_key', 'openai', value);
    const result = await validateAndStoreAiKey(app.db, ctx, id);
    expect(result).toMatchObject({
      ok: false,
      models: [],
      error:
        'This key cannot be used. Delete it, then copy the key again from the provider and save it.',
    });
    const route = await a.request({
      method: 'POST',
      url: `/api/v1/ai/keys/${id}/validate`,
      payload: {},
    });
    const list = await a.request({ method: 'GET', url: '/api/v1/ai/keys' });
    expectNone(JSON.stringify(result) + route.body + list.body + logs.lines.join('\n'), parts);
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it.each(REFUSED)(
  'calling, key %s already stored: refused before any call',
  async (_n, value, parts) => {
    const { app, a } = await boot();
    const ctx = ctxOf(a);
    await putSecret(app.db, ctx, 'ai_api_key', 'openai', value);
    const err: unknown = await (
      await buildAiDeps(app.db, ctx)
    )
      .getKey('openai')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect((err as AiUnavailableError).reason).toBe('no_key');
    expectNone(String(err), parts);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await app.db.select({ id: taskRuns.id }).from(taskRuns).all()).toEqual([]);
  },
);

it('calling: a stored key is given without the white space around it', async () => {
  const { app, a } = await boot();
  const ctx = ctxOf(a);
  await putSecret(app.db, ctx, 'ai_api_key', 'openai', ` ${GOOD}\n`);
  expect(await (await buildAiDeps(app.db, ctx)).getKey('openai')).toBe(GOOD);
});
