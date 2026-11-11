// Every AI provider through the server's checked, observed fetch (design.md 14.2, 14.12;
// https://github.com/bgoleno/opportun/issues/344, part 2 requirements 1 to 4). Before #344 only
// openai_compatible used it, and Anthropic and OpenAI reached the network through the SDK's own
// global fetch. Now all three do: https only, no prohibited host, every DNS answer public, and
// redirect: 'error'. The one exception is the operator's own ANTHROPIC_BASE_URL or
// OPENAI_BASE_URL (decision 40), whose origin skips the https and public-address checks.
//
// No test here touches DNS: the resolver is replaced (setProviderResolveOverride), and the real
// fetch is a stub, so nothing leaves the test.
import { runStructured, type ModelPolicy } from '@opportun/ai';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { obsMetricPoints } from '../src/db/schema';
import { buildAiDeps, setProviderResolveOverride } from '../src/lib/ai';
import { openAiModelsUrl } from '../src/lib/aiKeyValidate';
import type { ResolveHost } from '../src/lib/aiProviderFetch';
import { flushNow, setCollecting } from '../src/obs';
import { MINUTE_MS } from '../src/obs/metrics';
import { useApi } from './api';

const boot = useApi();
type App = Awaited<ReturnType<typeof boot>>['app'];
const KEY = 'sk-test-THIS-IS-A-SECRET-0123456789';
const call = { system: 's', prompt: 'p', schema: z.object({ label: z.string() }) };

const fetchMock = vi.fn<typeof fetch>();
const asked: string[] = [];
const resolvePublic: ResolveHost = async (host) => {
  asked.push(host);
  return ['93.184.216.34'];
};
const resolvePrivate: ResolveHost = async (host) => {
  asked.push(host);
  return ['10.0.0.5'];
};
const neverResolve: ResolveHost = async (host) => {
  throw new Error(`must not resolve ${host}`);
};

beforeEach(() => {
  asked.length = 0;
  fetchMock.mockReset();
  // A 400 is not retried, so each call makes exactly one request.
  fetchMock.mockResolvedValue(new Response('{"error":{"message":"stub"}}', { status: 400 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await setCollecting(false);
});

/**
 * The deps of a call, with the environment the server reads the operator's base URLs from given
 * here (never the real process.env, issue #292): empty by default, so the official APIs.
 */
async function depsFor(
  app: App,
  userId: string,
  policy?: ModelPolicy,
  env: NodeJS.ProcessEnv = {},
) {
  const deps = await buildAiDeps(app.db, { userId, isAdmin: false }, { env });
  deps.getKey = async () => KEY;
  if (policy !== undefined) deps.policyFor = async () => policy;
  return deps;
}

const OPENAI: ModelPolicy = { provider: 'openai', model: 'gpt-5-mini', maxOutputTokens: 100 };

function requested(): { url: string; init: RequestInit | undefined } {
  const [input, init] = fetchMock.mock.calls[0]!;
  return { url: input instanceof Request ? input.url : String(input), init };
}

describe('Anthropic and OpenAI go through the checked fetch (#344)', () => {
  it('an Anthropic call resolves api.anthropic.com first and never follows a redirect', async () => {
    const { app, a } = await boot();
    setProviderResolveOverride(app.db, resolvePublic);
    await runStructured(await depsFor(app, a.userId), 'comms.classify', call).catch(
      () => undefined,
    );
    expect(asked).toEqual(['api.anthropic.com']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requested().url.startsWith('https://api.anthropic.com/')).toBe(true);
    expect(requested().init).toMatchObject({ redirect: 'error' });
  });

  it('an OpenAI call does the same for api.openai.com', async () => {
    const { app, a } = await boot();
    setProviderResolveOverride(app.db, resolvePublic);
    await runStructured(await depsFor(app, a.userId, OPENAI), 'comms.classify', call).catch(
      () => undefined,
    );
    expect(asked).toEqual(['api.openai.com']);
    expect(requested().url.startsWith('https://api.openai.com/')).toBe(true);
    expect(requested().init).toMatchObject({ redirect: 'error' });
  });

  it('a provider host that answers with a private address is refused before any request', async () => {
    const { app, a } = await boot();
    setProviderResolveOverride(app.db, resolvePrivate);
    await expect(
      runStructured(await depsFor(app, a.userId), 'comms.classify', call),
    ).rejects.toMatchObject({ reason: 'provider_error' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the operator's own ANTHROPIC_BASE_URL or OPENAI_BASE_URL keeps working (#344, decision 40)", () => {
  it('a non-loopback http proxy at ANTHROPIC_BASE_URL is reached, without a DNS lookup', async () => {
    const { app, a } = await boot();
    setProviderResolveOverride(app.db, neverResolve);
    await runStructured(
      await depsFor(app, a.userId, undefined, { ANTHROPIC_BASE_URL: 'http://litellm:4000/v1' }),
      'comms.classify',
      call,
    ).catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requested().url.startsWith('http://litellm:4000/')).toBe(true);
    expect(requested().init).toMatchObject({ redirect: 'error' });
  });

  it('a private gateway at OPENAI_BASE_URL is reached', async () => {
    const { app, a } = await boot();
    setProviderResolveOverride(app.db, resolvePrivate);
    await runStructured(
      await depsFor(app, a.userId, OPENAI, { OPENAI_BASE_URL: 'https://gateway.corp.internal/v1' }),
      'comms.classify',
      call,
    ).catch(() => undefined);
    expect(requested().url.startsWith('https://gateway.corp.internal/')).toBe(true);
    expect(asked).toEqual([]);
  });

  it("the operator's origin is not a way past the check for anything else", async () => {
    const { app, a } = await boot();
    setProviderResolveOverride(app.db, resolvePrivate);
    // A user's own openai_compatible policy on another private host is still refused.
    const compatible: ModelPolicy = {
      provider: 'openai_compatible',
      model: 'llama',
      maxOutputTokens: 100,
      baseUrl: 'https://llm.internal.example/v1',
    };
    await expect(
      runStructured(
        await depsFor(app, a.userId, compatible, { ANTHROPIC_BASE_URL: 'http://litellm:4000' }),
        'comms.classify',
        call,
      ),
    ).rejects.toMatchObject({ reason: 'provider_error' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a base URL with credentials in it is refused, even as the operator set it', async () => {
    const { app, a } = await boot();
    setProviderResolveOverride(app.db, neverResolve);
    await expect(
      runStructured(
        await depsFor(app, a.userId, undefined, {
          ANTHROPIC_BASE_URL: 'http://user:pass@litellm:4000',
        }),
        'comms.classify',
        call,
      ),
    ).rejects.toMatchObject({ reason: 'provider_error' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('an OpenAI-compatible endpoint is checked whatever its origin (#344)', () => {
  const GATEWAY = 'https://gateway.corp.internal';
  const env = { OPENAI_BASE_URL: `${GATEWAY}/v1` };
  const compatible: ModelPolicy = {
    provider: 'openai_compatible',
    model: 'llama',
    maxOutputTokens: 100,
    baseUrl: `${GATEWAY}/other/v1`,
  };

  it('a call is refused before any request when the host answers with a private address', async () => {
    const { app, a } = await boot();
    setProviderResolveOverride(app.db, resolvePrivate);
    await expect(
      runStructured(await depsFor(app, a.userId, compatible, env), 'comms.classify', call),
    ).rejects.toMatchObject({ reason: 'provider_error' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('so is its key check, which lists models through the same fetch', async () => {
    const { app, a } = await boot();
    setProviderResolveOverride(app.db, resolvePrivate);
    const deps = await depsFor(app, a.userId, compatible, env);
    await expect(deps.providerFetch.fetch(`${GATEWAY}/other/v1/models`)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the control: an OpenAI call to that origin is still reached', async () => {
    const { app, a } = await boot();
    setProviderResolveOverride(app.db, resolvePrivate);
    await runStructured(await depsFor(app, a.userId, OPENAI, env), 'comms.classify', call).catch(
      () => undefined,
    );
    expect(requested().url.startsWith(`${GATEWAY}/v1/`)).toBe(true);
  });
});

describe('an OpenAI key is checked where its calls go (#344, decision 40)', () => {
  it('lists the models under the operator\u2019s OPENAI_BASE_URL when set, else the official API', async () => {
    const { app, a } = await boot();
    const official = await buildAiDeps(app.db, { userId: a.userId, isAdmin: false }, { env: {} });
    expect(openAiModelsUrl(official.providerFetch)).toBe('https://api.openai.com/v1/models');
    const proxied = await buildAiDeps(
      app.db,
      { userId: a.userId, isAdmin: false },
      { env: { OPENAI_BASE_URL: 'http://litellm:4000/v1/' } },
    );
    expect(openAiModelsUrl(proxied.providerFetch)).toBe('http://litellm:4000/v1/models');
  });
});

describe('the provider request is observed (#344, 14.2)', () => {
  async function outbound(app: App) {
    return app.db
      .select()
      .from(obsMetricPoints)
      .where(
        and(
          eq(obsMetricPoints.metric, 'http.client.request.duration'),
          eq(obsMetricPoints.resolution, MINUTE_MS),
        ),
      )
      .all();
  }

  it('names its target, and the fixed host only for the official API', async () => {
    const { app, a } = await boot();
    await setCollecting(true);
    setProviderResolveOverride(app.db, resolvePublic);
    await runStructured(await depsFor(app, a.userId), 'comms.classify', call).catch(
      () => undefined,
    );
    await runStructured(
      await depsFor(app, a.userId, OPENAI, { OPENAI_BASE_URL: 'http://litellm:4000/v1' }),
      'comms.classify',
      call,
    ).catch(() => undefined);
    await flushNow();
    const attrs = (await outbound(app)).map((p) => p.attributes);
    expect(attrs).toContainEqual(
      expect.objectContaining({
        'opportun.outbound.target': 'anthropic',
        'server.address': 'api.anthropic.com',
        'http.response.status_code': 400,
      }),
    );
    const proxied = attrs.find((x) => x['opportun.outbound.target'] === 'openai');
    expect(proxied).toBeDefined();
    expect(proxied).not.toHaveProperty('server.address');
  });
});
