// Batch requests (#441, slice 1 of https://github.com/bgoleno/opportun/issues/358; tl's design
// issuecomment-6794239917 and ruling on #441): one request builder for the live call and a batch,
// the batch multiplier in the price table, the estimate a batch holds, the live path's parse, and
// no provider with a batch client yet. Every key and text here is made up.
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  batchMultiplier,
  batchProviderFor,
  batchRunRecord,
  estimateBatchRequestUsd,
  parseStructuredText,
} from './batch';
import { resolvePolicy } from './policies';
import { estimateCost } from './pricing';
import { createLanguageModel } from './providers';
import { runStructured, structuredRequest } from './router';
import type { AiDeps, ModelPolicy } from './types';

vi.mock('./providers', async (importOriginal) => {
  const real = await importOriginal<typeof import('./providers')>();
  return { ...real, createLanguageModel: vi.fn() };
});

const Score = z.object({ score: z.number().int().min(0).max(100), rationale: z.string() });
const PREFIX = 'Fixed instructions for every posting. '.repeat(120);
const REST = '<untrusted>\nCompany: Example Corp\nTitle: Staff Engineer\n</untrusted>';
const OPTS = {
  system: PREFIX + REST,
  cacheBreak: PREFIX.length,
  prompt: 'Score the posting and return the result.',
  schema: Score,
};
const SONNET: ModelPolicy = resolvePolicy('discovery.rank', undefined);

function ok(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 80, text: 80, reasoning: 0 },
    },
    warnings: [],
  };
}

describe('one request builder for the live call and a batch', () => {
  it('splits the system for the cache as the live call does, with the policy output limit', () => {
    const req = structuredRequest(SONNET, OPTS);
    expect(req.system).toEqual([
      {
        role: 'system',
        content: PREFIX,
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      },
      { role: 'system', content: REST },
    ]);
    expect(req.prompt).toBe(OPTS.prompt);
    expect(req.maxOutputTokens).toBe(SONNET.maxOutputTokens);
    expect(req.schema).toBe(Score);
  });

  it('the live call hands the model exactly what the builder builds', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: ok(JSON.stringify({ score: 70, rationale: 'fits' })),
    });
    vi.mocked(createLanguageModel).mockReturnValue(model);
    const deps: AiDeps = {
      getKey: async () => 'sk-test-key-0123456789',
      policyFor: async () => SONNET,
      record: async () => {},
      budget: { perTaskDailyUsd: 5 },
      spentTodayUsd: async () => 0,
      providerFetch: {
        fetch: (() => Promise.reject(new Error('unused'))) as typeof fetch,
        allowLoopbackHttp: false,
      },
    };
    await runStructured(deps, 'discovery.rank', OPTS);
    const call = model.doGenerateCalls[0]!;
    const req = structuredRequest(SONNET, OPTS);
    const blocks = req.system as { content: string; providerOptions?: unknown }[];
    const system = call.prompt.filter((m) => m.role === 'system');
    expect(system.map((m) => m.content)).toEqual(blocks.map((b) => b.content));
    expect(system[0]?.providerOptions).toEqual(blocks[0]?.providerOptions);
    const user = call.prompt.find((m) => m.role === 'user');
    expect(user?.content).toEqual([{ type: 'text', text: req.prompt }]);
    expect(call.maxOutputTokens).toBe(req.maxOutputTokens);
    expect(call.temperature).toBe(req.temperature);
  });

  it('a provider that caches nothing gets the system whole, in a batch as live', () => {
    const openai: ModelPolicy = { provider: 'openai', model: 'gpt-5', maxOutputTokens: 2000 };
    expect(structuredRequest(openai, OPTS).system).toBe(OPTS.system);
  });
});

describe('the batch multiplier in the price table', () => {
  it('Anthropic batches cost half; no other provider has batches yet', () => {
    expect(batchMultiplier('anthropic')).toBe(0.5);
    expect(batchMultiplier('openai')).toBeUndefined();
    expect(batchMultiplier('openai-compatible')).toBeUndefined();
  });

  it('halves input, output and both cache rates alike', () => {
    const live = estimateCost('anthropic', SONNET.model, 10_000, 2_000, undefined, {
      readTokens: 3_000,
      writeTokens: 1_000,
    });
    const batch = estimateCost(
      'anthropic',
      SONNET.model,
      10_000,
      2_000,
      undefined,
      { readTokens: 3_000, writeTokens: 1_000 },
      { batch: true },
    );
    expect(batch.usd).toBeCloseTo(live.usd * 0.5, 12);
  });

  it("a user's own price override gets the same multiplier", () => {
    const override = { inputUsdPerMTok: 4, outputUsdPerMTok: 20 };
    const live = estimateCost('anthropic', SONNET.model, 1_000_000, 1_000_000, override);
    const batch = estimateCost(
      'anthropic',
      SONNET.model,
      1_000_000,
      1_000_000,
      override,
      undefined,
      {
        batch: true,
      },
    );
    expect(live.usd).toBe(24);
    expect(batch.usd).toBe(12);
  });
});

describe('what a batch request is estimated to cost (tl on #441)', () => {
  const req = structuredRequest(SONNET, OPTS);
  const chars = OPTS.system.length + OPTS.prompt.length;

  it('input from what is sent; output the average of 20 or more successful calls', () => {
    const usd = estimateBatchRequestUsd(SONNET, req, { outputTokens: 120, calls: 20 });
    const input = Math.ceil(chars / 3) + 344;
    expect(usd).toBeCloseTo(
      estimateCost('anthropic', SONNET.model, input, 120, SONNET, undefined, { batch: true }).usd,
      12,
    );
  });

  it('with fewer than 20 successful calls, the output limit', () => {
    const usd = estimateBatchRequestUsd(SONNET, req, { outputTokens: 120, calls: 19 });
    const input = Math.ceil(chars / 3) + 344;
    expect(usd).toBeCloseTo(
      estimateCost('anthropic', SONNET.model, input, SONNET.maxOutputTokens, SONNET, undefined, {
        batch: true,
      }).usd,
      12,
    );
  });
});

describe('a batch result goes through the live call parse and validation', () => {
  it('a valid object is returned', () => {
    expect(parseStructuredText('{"score":70,"rationale":"fits"}', Score)).toEqual({
      ok: true,
      value: { score: 70, rationale: 'fits' },
    });
  });

  it.each([
    ['not JSON', 'Score: 70'],
    ['a value outside the schema', '{"score":170,"rationale":"fits"}'],
    ['a missing field', '{"score":70}'],
    ['an empty text', ''],
  ])('%s is invalid output', (_, text) => {
    expect(parseStructuredText(text, Score)).toEqual({ ok: false, reason: 'invalid_output' });
  });
});

describe('the run record of a batch result', () => {
  it('is priced at the batch rate, with the tokens the provider reported', () => {
    const rec = batchRunRecord(
      'discovery.rank',
      SONNET,
      {
        input: 1_000,
        output: 100,
        cacheRead: 600,
        cacheWrite: 0,
      },
      { promptId: 'prompt-1' },
    );
    expect(rec).toMatchObject({
      taskKey: 'discovery.rank',
      provider: 'anthropic',
      model: SONNET.model,
      inputTokens: 1_000,
      outputTokens: 100,
      status: 'ok',
      promptId: 'prompt-1',
    });
    expect(rec.estCostUsd).toBeCloseTo(
      estimateCost(
        'anthropic',
        SONNET.model,
        1_000,
        100,
        SONNET,
        { readTokens: 600, writeTokens: 0 },
        {
          batch: true,
        },
      ).usd,
      12,
    );
  });
});

// Anthropic has a client since #509 (anthropicBatch.test.ts); every other provider still has none.
describe('a provider without a batch client', () => {
  it.each([
    ['openai', { provider: 'openai', model: 'gpt-5', maxOutputTokens: 2000 } as ModelPolicy],
    [
      'openai_compatible',
      {
        provider: 'openai_compatible',
        model: 'local',
        maxOutputTokens: 2000,
        baseUrl: 'https://llm.example.com/v1',
      } as ModelPolicy,
    ],
  ])('%s: none, so ranking stays live', (_, policy) => {
    expect(
      batchProviderFor({
        policy,
        apiKey: 'sk-test-key-0123456789',
        providerFetch: {
          fetch: (() => Promise.reject(new Error('unused'))) as typeof fetch,
          allowLoopbackHttp: false,
        },
      }),
    ).toBeNull();
  });
});
