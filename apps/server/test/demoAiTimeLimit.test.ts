// On a demo server an AI call has a time limit of its own (https://github.com/bgoleno/opportun/issues/656,
// from tl's and sec's reviews of #638): a call that runs on holds the demo reset's gate for as long
// as it runs, so it is aborted below the gate's hold bound, and the caller gets the usual
// AI-unavailable outcome. Off the demo nothing changes. The provider is a stub of the global fetch
// the provider path ends in: no network, and the key is made up.
import { AiUnavailableError, runStructured } from '@opportun/ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { liveMessage } from '../../../packages/ai/src/anthropicBatch.fixtures';
import { buildAiDeps } from '../src/lib/ai';
import { useApi } from './api';
import type { TestClient } from './isolation';

const Score = z.object({ score: z.number(), rationale: z.string() });
const OPTS = { system: 'Score the posting.', prompt: 'A posting.', schema: Score };
const ANSWER = JSON.stringify({ score: 5, rationale: 'Fits.' });

/** The provider: answers after `delayMs`, or when the request's signal aborts, whichever is first. */
function provider(delayMs: number) {
  const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(init.signal?.reason ?? new Error('aborted'));
      });
    });
    return new Response(JSON.stringify(liveMessage(ANSWER)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

async function addKey(c: TestClient) {
  const res = await c.request({
    method: 'POST',
    url: '/api/v1/secrets',
    payload: { kind: 'ai_api_key', label: 'anthropic', value: 'sk-ant-made-up-key-0123456789' },
  });
  expect(res.statusCode, res.body).toBe(201);
}

describe('an AI call on a demo server has a time limit (#656)', () => {
  let limitMs: number | undefined;
  const boot = useApi(() =>
    limitMs === undefined ? {} : { build: { demoResetLimits: { aiCallMs: limitMs } } },
  );
  beforeEach(() => {
    limitMs = undefined;
  });

  it('on a demo server, a call that runs past the limit is aborted: the usual AI-unavailable outcome', async () => {
    limitMs = 100;
    const { app, a } = await boot({ demo: true });
    await addKey(a);
    const fetchMock = provider(5_000);
    const deps = await buildAiDeps(app.db, { userId: a.userId, isAdmin: false });
    const started = Date.now();
    await expect(runStructured(deps, 'discovery.rank', OPTS)).rejects.toBeInstanceOf(
      AiUnavailableError,
    );
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('the limit is one deadline for the whole call, its retries included (tl on #670)', async () => {
    // Each request answers 503 after 150 ms, under the limit, and the SDK retries a 503: with a
    // limit per request the call would run three of them (450 ms and more); one deadline ends it.
    limitMs = 250;
    const { app, a } = await boot({ demo: true });
    await addKey(a);
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 150);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(init.signal?.reason ?? new Error('aborted'));
        });
      });
      return new Response(
        JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const deps = await buildAiDeps(app.db, { userId: a.userId, isAdmin: false });
    const started = Date.now();
    await expect(runStructured(deps, 'discovery.rank', OPTS)).rejects.toBeInstanceOf(
      AiUnavailableError,
    );
    // Within the one deadline (and the SDK's backoff between tries), not three requests' worth.
    expect(Date.now() - started).toBeLessThan(400);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('on a demo server, a call that answers within the limit is unchanged', async () => {
    limitMs = 2_000;
    const { app, a } = await boot({ demo: true });
    await addKey(a);
    provider(10);
    const deps = await buildAiDeps(app.db, { userId: a.userId, isAdmin: false });
    await expect(runStructured(deps, 'discovery.rank', OPTS)).resolves.toEqual({
      score: 5,
      rationale: 'Fits.',
    });
  });

  it('off the demo there is no such limit: a slower answer still comes back', async () => {
    // The same short limit asked for, on a server that is not a demo: it does not apply.
    limitMs = 100;
    const { app, a } = await boot({ demo: false });
    await addKey(a);
    provider(400);
    const deps = await buildAiDeps(app.db, { userId: a.userId, isAdmin: false });
    await expect(runStructured(deps, 'discovery.rank', OPTS)).resolves.toEqual({
      score: 5,
      rationale: 'Fits.',
    });
  });
});
