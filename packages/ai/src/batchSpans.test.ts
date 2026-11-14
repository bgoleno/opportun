// The batch spans (#509 criterion 5; tl's ruling on #509): one span for submitting and one for
// collecting, under #344's Gen AI conventions, and none for each request. Against the fixtures of
// anthropicBatch.fixtures.ts: no network, and every key here is made up.
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BATCH_ID,
  canceledLine,
  erroredLine,
  expiredLine,
  jsonl,
  messageBatch,
  succeededLine,
} from './anthropicBatch.fixtures';
import { batchProviderFor } from './batch';
import { resolvePolicy } from './policies';
import { estimateCost } from './pricing';
import { structuredRequest } from './router';
import type { ModelPolicy } from './types';

const exporter = new InMemorySpanExporter();
let provider: TracerProvider;

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  trace.setGlobalTracerProvider(provider);
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
});
beforeEach(() => exporter.reset());

const SONNET: ModelPolicy = resolvePolicy('discovery.rank', undefined);
const Score = z.object({ score: z.number().int(), rationale: z.string() });
const request = (customId: string) => ({
  customId,
  request: structuredRequest(SONNET, {
    system: 'Rank the posting.',
    prompt: 'Score it.',
    schema: Score,
  }),
});

function client(answer: () => Response) {
  const fetch = (async () => answer()) as typeof globalThis.fetch;
  const p = batchProviderFor({
    policy: SONNET,
    apiKey: 'sk-ant-test-0123456789abcdefghij',
    providerFetch: { fetch, allowLoopbackHttp: false },
  });
  if (p === null) throw new Error('expected an Anthropic batch client');
  return p;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const BASE = {
  'gen_ai.provider.name': 'anthropic',
  'opportun.ai.provider': 'anthropic',
  'gen_ai.request.model': SONNET.model,
};

describe('the submit span', () => {
  it('one span for the batch, however many requests: their count and the batch id', async () => {
    await client(() => json(messageBatch('in_progress'))).submit([
      request('posting_1'),
      request('posting_2'),
      request('posting_3'),
    ]);
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span!.name).toBe(`batch_submit ${SONNET.model}`);
    expect(span!.kind).toBe(SpanKind.CLIENT);
    expect(span!.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(span!.attributes).toEqual({
      'gen_ai.operation.name': 'batch_submit',
      ...BASE,
      'opportun.gen_ai.batch.requests': 3,
      'opportun.gen_ai.batch.id': BATCH_ID,
    });
  });

  it('a refused submit is an error span with the router reason, no batch id and no text', async () => {
    await expect(
      client(() => json({ type: 'error', error: { type: 'overloaded_error' } }, 529)).submit([
        request('posting_1'),
      ]),
    ).rejects.toThrow(/529/);
    const [span] = exporter.getFinishedSpans();
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.status.message).toBeUndefined();
    expect(span!.events).toEqual([]);
    expect(span!.attributes).toEqual({
      'gen_ai.operation.name': 'batch_submit',
      ...BASE,
      'opportun.gen_ai.batch.requests': 1,
      'error.type': 'provider_error',
    });
  });
});

describe('the collect span', () => {
  it('one span for the results: counts by result type, total tokens and the batch cost', async () => {
    const usage = {
      input_tokens: 120,
      output_tokens: 48,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 2400,
    };
    const file = jsonl([
      succeededLine('posting_1', '{"score":70,"rationale":"fits"}', usage),
      succeededLine('posting_2', '{"score":10,"rationale":"no"}', usage),
      erroredLine('posting_3', 'invalid_request_error', 'bad'),
      erroredLine('posting_4', 'overloaded_error', 'Overloaded'),
      expiredLine('posting_5'),
      canceledLine('posting_6'),
    ]);
    await client(() => new Response(file)).results(BATCH_ID);
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span!.name).toBe(`batch_collect ${SONNET.model}`);
    expect(span!.kind).toBe(SpanKind.CLIENT);
    const input = 2 * (120 + 30 + 2400);
    const cost =
      2 *
      estimateCost(
        'anthropic',
        SONNET.model,
        120 + 30 + 2400,
        48,
        SONNET,
        { readTokens: 2400, writeTokens: 30 },
        { batch: true },
      ).usd;
    expect(span!.attributes).toEqual({
      'gen_ai.operation.name': 'batch_collect',
      ...BASE,
      'opportun.gen_ai.batch.id': BATCH_ID,
      'opportun.gen_ai.batch.succeeded': 2,
      'opportun.gen_ai.batch.errored': 2,
      'opportun.gen_ai.batch.expired': 1,
      'opportun.gen_ai.batch.canceled': 1,
      'gen_ai.usage.input_tokens': input,
      'gen_ai.usage.output_tokens': 96,
      'gen_ai.usage.cache_read.input_tokens': 4800,
      'gen_ai.usage.cache_write.input_tokens': 60,
      'opportun.gen_ai.usage.cost': cost,
    });
  });

  it('reading the state makes no span: only submitting and collecting do', async () => {
    await client(() => json(messageBatch('in_progress'))).state(BATCH_ID);
    expect(exporter.getFinishedSpans()).toEqual([]);
  });
});
