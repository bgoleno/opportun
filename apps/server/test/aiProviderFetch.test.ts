// SSRF/compliance tests for the AI provider path (issue #334). Two levels on purpose:
//
// - Unit tests of createProviderFetch/checkProviderUrl directly, with no app, no database, no
//   HTTP: these are the compliance proof the SECURITY.md deviation entry's own comment in
//   aiProviderFetch.ts points at -- that every https target actually consults BOTH
//   isProhibitedHost and isPrivateAddress (not merely that the symbols are imported), and that
//   redirect: 'error' is the real default. Each blocking case asserts the stubbed real fetch
//   was never called at all: the point is proving the absence of the outbound attempt, not the
//   presence of a thrown error.
// - One end-to-end case per blocked class, through validateAiKey, against a policy row written
//   directly into settings (not through PUT /ai/policies): that route's own submit-time
//   isSafeBaseUrl check is shape-only (scheme, credentials) and does not refuse an
//   openai_compatible policy pointed at a prohibited or private host, so a fixture built
//   through it would not be testing this invariant. Building the row directly proves the fetch
//   layer, not the write path, is what blocks it.
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateAiKey } from '../src/lib/aiKeyValidate';
import { setProviderResolveOverride } from '../src/lib/ai';
import { createProviderFetch, type ResolveHost } from '../src/lib/aiProviderFetch';
import { settings } from '../src/db/schema';
import { useApi } from './api';
import type { TestClient } from './isolation';

const PUBLIC_IP = '93.184.216.34';
const resolvePublic: ResolveHost = async () => [PUBLIC_IP];
const resolvePrivate: ResolveHost = async () => ['10.0.0.5'];
const neverResolve: ResolveHost = async () => {
  throw new Error('unit test: resolve should not have been reached for this case');
};

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createProviderFetch: scheme and the loopback allowance (issue #334)', () => {
  it('allows https to a public address, reaching the real fetch', async () => {
    const providerFetch = createProviderFetch({ allowLoopbackHttp: false }, resolvePublic);
    await providerFetch('https://llm.example.com/v1/models');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses http on localhost by default: zero outbound attempts', async () => {
    const providerFetch = createProviderFetch({ allowLoopbackHttp: false }, neverResolve);
    await expect(providerFetch('http://localhost:11434/v1/models')).rejects.toThrow(/scheme/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows http on localhost once the operator opts in, by literal hostname, never resolved', async () => {
    const providerFetch = createProviderFetch({ allowLoopbackHttp: true }, neverResolve);
    await providerFetch('http://localhost:11434/v1/models');
    await providerFetch('http://127.0.0.1:11434/v1/models');
    await providerFetch('http://[::1]:11434/v1/models');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never allows http off the three literal loopback hostnames, even opted in: zero attempts', async () => {
    const providerFetch = createProviderFetch({ allowLoopbackHttp: true }, neverResolve);
    await expect(providerFetch('http://localhost.evil.example/v1')).rejects.toThrow(/scheme/);
    await expect(providerFetch('http://10.0.0.5/v1')).rejects.toThrow(/scheme/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a non-http(s) scheme and embedded credentials: zero attempts', async () => {
    const providerFetch = createProviderFetch({ allowLoopbackHttp: false }, neverResolve);
    await expect(providerFetch('ftp://example.com/v1')).rejects.toThrow(/scheme/);
    await expect(providerFetch('https://u:p@example.com/v1')).rejects.toThrow(/credentials/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('createProviderFetch: PROHIBITED_HOSTS compliance (issue #334)', () => {
  it('refuses linkedin.com and a subdomain of it: zero outbound attempts', async () => {
    const providerFetch = createProviderFetch({ allowLoopbackHttp: false }, resolvePublic);
    await expect(providerFetch('https://www.linkedin.com/v1/models')).rejects.toThrow(
      /host_not_allowed/,
    );
    await expect(providerFetch('https://api.linkedin.com/v1/models')).rejects.toThrow(
      /host_not_allowed/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses lnkd.in', async () => {
    const providerFetch = createProviderFetch({ allowLoopbackHttp: false }, resolvePublic);
    await expect(providerFetch('https://lnkd.in/v1/models')).rejects.toThrow(/host_not_allowed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks a prohibited host before ever resolving it: the resolver is never called', async () => {
    const providerFetch = createProviderFetch({ allowLoopbackHttp: false }, neverResolve);
    await expect(providerFetch('https://www.linkedin.com/v1/models')).rejects.toThrow(
      /host_not_allowed/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('createProviderFetch: private-address rejection (issue #334)', () => {
  it('refuses an IP-literal private address: zero outbound attempts', async () => {
    const providerFetch = createProviderFetch({ allowLoopbackHttp: false }, neverResolve);
    for (const ip of ['10.0.0.5', '192.168.1.1', '127.0.0.1', '169.254.169.254']) {
      await expect(providerFetch(`https://${ip}/v1/models`)).rejects.toThrow(/private_address/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a hostname that resolves to a private address: zero outbound attempts', async () => {
    const providerFetch = createProviderFetch({ allowLoopbackHttp: false }, resolvePrivate);
    await expect(providerFetch('https://internal.example.com/v1/models')).rejects.toThrow(
      /private_address/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a public address is not blocked: reaches the real fetch', async () => {
    const providerFetch = createProviderFetch({ allowLoopbackHttp: false }, resolvePublic);
    await providerFetch('https://93.184.216.34/v1/models');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('createProviderFetch: redirect policy (issue #334)', () => {
  it('defaults to redirect: "error", never following a 3xx', async () => {
    const providerFetch = createProviderFetch({ allowLoopbackHttp: false }, resolvePublic);
    await providerFetch('https://llm.example.com/v1/models');
    expect(fetchMock.mock.calls[0]![1]?.redirect).toBe('error');
  });

  it("carries a caller's own explicit redirect choice instead of overriding it", async () => {
    const providerFetch = createProviderFetch({ allowLoopbackHttp: false }, resolvePublic);
    await providerFetch('https://llm.example.com/v1/models', { redirect: 'manual' });
    expect(fetchMock.mock.calls[0]![1]?.redirect).toBe('manual');
  });
});

describe('end-to-end: a directly-written policy row cannot reach a prohibited or private host (issue #334)', () => {
  const boot = useApi();

  async function writeCompatiblePolicy(
    c: TestClient,
    app: Awaited<ReturnType<typeof boot>>['app'],
    task: string,
    baseUrl: string,
  ): Promise<void> {
    // Not PUT /api/v1/ai/policies/:task: that route's isSafeBaseUrl check is shape-only
    // (scheme, credentials) and does not refuse a prohibited or private host, so a policy
    // built through it would not be testing this invariant -- only the fetch layer does.
    const now = Date.now();
    await app.db
      .insert(settings)
      .values({
        key: `ai_policy:${task}:${c.userId}`,
        userId: c.userId,
        value: { provider: 'openai_compatible', model: 'llama', maxOutputTokens: 100, baseUrl },
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: {
          value: { provider: 'openai_compatible', model: 'llama', maxOutputTokens: 100, baseUrl },
          updatedAt: now,
        },
      })
      .run();
  }

  async function addCompatibleKey(c: TestClient): Promise<string> {
    const res = await c.request({
      method: 'POST',
      url: '/api/v1/secrets',
      payload: {
        kind: 'ai_api_key',
        label: 'openai_compatible',
        value: randomBytes(16).toString('hex'),
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { id: string }).id;
  }

  beforeEach(() => {
    fetchMock.mockRejectedValue(new Error('must not be reached: this is the SSRF/compliance gap'));
  });

  it('a LinkedIn baseUrl: validateAiKey reports failure, and nothing was ever fetched', async () => {
    const { app, a } = await boot();
    setProviderResolveOverride(app.db, resolvePublic);
    await writeCompatiblePolicy(a, app, 'comms.classify', 'https://www.linkedin.com/v1');
    const secretId = await addCompatibleKey(a);
    const v = await validateAiKey(app.db, { userId: a.userId, isAdmin: false }, secretId);
    expect(v.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a private-address baseUrl: validateAiKey reports failure, and nothing was ever fetched', async () => {
    const { app, a } = await boot();
    setProviderResolveOverride(app.db, resolvePublic);
    await writeCompatiblePolicy(a, app, 'comms.classify', 'https://10.0.0.5/v1');
    const secretId = await addCompatibleKey(a);
    const v = await validateAiKey(app.db, { userId: a.userId, isAdmin: false }, secretId);
    expect(v.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a safe baseUrl still works: the invariant above is about the specific hosts, not fetch in general', async () => {
    const { app, a } = await boot();
    setProviderResolveOverride(app.db, resolvePublic);
    await writeCompatiblePolicy(a, app, 'comms.classify', 'https://llm.example.com/v1');
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    // addCompatibleKey's own POST /secrets already triggers one inline validation call
    // (routes/secrets.ts); clear it so the count below is only this test's own explicit call.
    const secretId = await addCompatibleKey(a);
    fetchMock.mockClear();
    const v = await validateAiKey(app.db, { userId: a.userId, isAdmin: false }, secretId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(v.error).toBeNull();
  });
});
