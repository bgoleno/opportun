// What the prompt-caching split puts on the wire (https://github.com/bgoleno/opportun/issues/356).
// router.test.ts mocks the provider; this goes through the real Anthropic and OpenAI clients with
// a fetch that records the request body, so it checks the cache_control the API actually gets.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resolvePolicy } from './policies';
import { runStructured } from './router';
import type { AiDeps, ModelPolicy, TaskKey } from './types';

const longPrefix = 'Fixed instructions and a table. '.repeat(80);
const split = { prefix: longPrefix, rest: '<untrusted>\nper-call\n</untrusted>' };

async function bodyOf(policy?: ModelPolicy): Promise<Record<string, unknown>> {
  const bodies: Record<string, unknown>[] = [];
  const recording = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    // The body is all this test needs: fail the call here.
    throw new Error('recorded');
  }) as typeof fetch;
  const task: TaskKey = 'discovery.company_tags';
  const deps: AiDeps = {
    getKey: async () => 'sk-test-key-0123456789',
    policyFor: async (t) => resolvePolicy(t, t === task ? policy : undefined),
    record: async () => {},
    budget: { perTaskDailyUsd: 5 },
    spentTodayUsd: async () => 0,
    providerFetch: { fetch: recording, allowLoopbackHttp: false },
  };
  await expect(
    runStructured(deps, task, {
      system: split,
      prompt: 'Tag them.',
      schema: z.object({ ok: z.boolean() }),
    }),
  ).rejects.toThrow();
  expect(bodies.length).toBeGreaterThan(0);
  return bodies[0]!;
}

describe('the prompt-caching split on the wire (#356)', () => {
  it('sends Anthropic the prefix as its own system block, with cache_control, then the rest', async () => {
    const body = await bodyOf();
    expect(body['system']).toEqual([
      { type: 'text', text: longPrefix, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: split.rest },
    ]);
  });

  it('sends OpenAI one system message, whole, with no cache marker', async () => {
    const body = await bodyOf({ provider: 'openai', model: 'gpt-5', maxOutputTokens: 2000 });
    const text = JSON.stringify(body);
    expect(text).not.toContain('cache_control');
    expect(text).toContain(JSON.stringify(split.prefix + split.rest).slice(1, -1));
  });
});
