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

  // One deadline for the whole call, its retries included (tl on #670). No clock is read (#915): the
  // call ends with a ledger write the deadline does not cover, and a busy disk made that slow. Timers
  // fire in the order they are due, however late: the deadline (250 ms from the call's start) always
  // comes before a second request's answer (two waits of 150 ms), so load cannot fail this. With a
  // deadline per try each answer comes, unless the process stalls for 100 ms as a request starts.
  describe('is one deadline for the whole call', () => {
    const LIMIT_MS = 250;
    const ANSWER_MS = 150;

    /** The provider: each request gets `answer()` after ANSWER_MS, unless its signal aborts first. */
    function slowProvider(answer: () => Response) {
      const seen = { requests: 0, answered: 0 };
      vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
        seen.requests += 1;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, ANSWER_MS);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(init.signal?.reason ?? new Error('aborted'));
          });
        });
        seen.answered += 1;
        return answer();
      });
      return seen;
    }

    async function call() {
      limitMs = LIMIT_MS;
      const { app, a } = await boot({ demo: true });
      await addKey(a);
      const deps = await buildAiDeps(app.db, { userId: a.userId, isAdmin: false });
      return { run: () => runStructured(deps, 'discovery.rank', OPTS) };
    }

    it('with the SDK’s own retries in it', async () => {
      const { run } = await call();
      // Retried at once: without the header the SDK waits 2 s first, past the limit, so nothing
      // would be retried within it.
      const seen = slowProvider(
        () =>
          new Response(
            JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }),
            { status: 503, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' } },
          ),
      );
      await expect(run()).rejects.toBeInstanceOf(AiUnavailableError);
      expect(seen.answered).toBeLessThanOrEqual(1);
      expect(seen.requests).toBeLessThanOrEqual(2);
    });

    it('with the retry of an answer that does not fit the schema in it', async () => {
      const { run } = await call();
      const seen = slowProvider(
        () =>
          new Response(JSON.stringify(liveMessage(JSON.stringify({ score: 'high' }))), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      // Ended by the deadline, not by two answers that do not fit.
      await expect(run()).rejects.toMatchObject({ reason: 'provider_error' });
      expect(seen.answered).toBeLessThanOrEqual(1);
      expect(seen.requests).toBeLessThanOrEqual(2);
    });
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
