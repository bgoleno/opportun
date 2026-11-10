// Gen AI spans of the model router (https://github.com/bgoleno/opportun/issues/344, FR-T4 part 1;
// docs/design.md 14.5, 14.6 and 14.8). Every test runs against a mocked provider and an in-memory
// tracer provider: no network, no real keys, no export. What matters most here is what is NOT on a
// span: a prompt, a response or an error text can hold a resume or a contact's name.
import type { LanguageModelV4GenerateResult, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace';
import { APICallError, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { pingModel } from './keyCheck';
import { DEFAULT_POLICIES, resolvePolicy } from './policies';
import { estimateCostUsd } from './pricing';
import { createLanguageModel } from './providers';
import { runStructured, streamChat } from './router';
import { userInContext, withUser } from './telemetry';
import {
  AiUnavailableError,
  type AiDeps,
  type ModelPolicy,
  type TaskKey,
  type TaskRunRecord,
} from './types';

vi.mock('./providers', async (importOriginal) => {
  const real = await importOriginal<typeof import('./providers')>();
  return { ...real, createLanguageModel: vi.fn() };
});

const KEY = 'sk-test-SECRET-key-0123456789';
const CANARY = 'CANARY-Jane-Doe-jane.doe@example.com-555-0100';
const PROVIDER_FETCH = {
  fetch: (() => Promise.reject(new Error('unused: createLanguageModel is mocked'))) as typeof fetch,
  allowLoopbackHttp: false,
};

const exporter = new InMemorySpanExporter();
let provider: TracerProvider;

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
});

beforeEach(() => {
  exporter.reset();
  vi.mocked(createLanguageModel).mockReset();
});

function finished(): ReadableSpan[] {
  return exporter.getFinishedSpans();
}

function only(): ReadableSpan {
  const spans = finished();
  expect(spans.map((s) => s.name)).toHaveLength(1);
  return spans[0]!;
}

function ok(
  text: string,
  extra: Partial<LanguageModelV4GenerateResult> = {},
): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'end_turn' },
    usage: {
      inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 50, text: 50, reasoning: 0 },
    },
    warnings: [],
    response: { id: 'resp_123', modelId: 'claude-opus-5-5-20260101' },
    ...extra,
  };
}

interface Harness {
  deps: AiDeps;
  runs: TaskRunRecord[];
  model: MockLanguageModelV4;
}

function harness(
  opts: {
    model?: MockLanguageModelV4;
    overrides?: Partial<Record<TaskKey, ModelPolicy>>;
    spent?: number;
    hasKey?: boolean;
    userId?: string | null;
    onRecordError?: AiDeps['onRecordError'];
  } = {},
): Harness {
  const runs: TaskRunRecord[] = [];
  const model = opts.model ?? new MockLanguageModelV4({ doGenerate: ok('{"score":1}') });
  vi.mocked(createLanguageModel).mockReturnValue(model);
  const deps: AiDeps = {
    getKey: async () => {
      if (opts.hasKey === false) throw new AiUnavailableError('no_key');
      return KEY;
    },
    policyFor: async (task) =>
      resolvePolicy(task, new Map(Object.entries(opts.overrides ?? {})).get(task)),
    record: async (run) => {
      runs.push(run);
    },
    budget: { perTaskDailyUsd: 5 },
    spentTodayUsd: async () => opts.spent ?? 0,
    providerFetch: PROVIDER_FETCH,
    ...(opts.userId === null ? {} : { userId: opts.userId ?? 'user-1' }),
    ...(opts.onRecordError === undefined ? {} : { onRecordError: opts.onRecordError }),
  };
  return { deps, runs, model };
}

const Score = z.object({ score: z.number() });
const call = { system: 'sys', prompt: 'hello', schema: Score };
const chatCall = { system: 'sys', messages: [{ role: 'user' as const, content: 'hi' }] };

function streamModel(text: string, opts: { initialDelayInMs?: number } = {}): MockLanguageModelV4 {
  const chunks: LanguageModelV4StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id: 'resp_stream_1', modelId: 'claude-opus-5-5-20260101' },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'end_turn' },
      usage: {
        inputTokens: { total: 30, noCache: 30, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 7, text: 7, reasoning: 0 },
      },
    },
  ];
  return new MockLanguageModelV4({
    doStream: {
      stream: simulateReadableStream({ chunks, initialDelayInMs: opts.initialDelayInMs ?? null }),
    },
  });
}

async function drain(res: Awaited<ReturnType<typeof streamChat>>): Promise<string> {
  let text = '';
  for await (const delta of res.textStream) text += delta;
  return text;
}

/** Every attribute key a router span may carry. A new key is a deliberate edit to this list. */
const ALLOWED_KEYS = new Set([
  'gen_ai.operation.name',
  'gen_ai.provider.name',
  'gen_ai.request.model',
  'gen_ai.response.model',
  'gen_ai.request.max_tokens',
  'gen_ai.request.temperature',
  'gen_ai.request.stream',
  'gen_ai.output.type',
  'gen_ai.prompt.name',
  'gen_ai.prompt.version',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.cache_read.input_tokens',
  'gen_ai.usage.cache_write.input_tokens',
  'gen_ai.response.id',
  'gen_ai.response.finish_reasons',
  'gen_ai.response.time_to_first_chunk',
  'gen_ai.conversation.id',
  'error.type',
  'opportun.ai.provider',
  'opportun.ai.task',
  'opportun.ai.feature',
  'opportun.ai.prompt.id',
  'opportun.ai.attempts',
  'opportun.gen_ai.usage.cost',
  'user.id',
]);

/** The content attributes of the conventions: never set, stored or exported (NFR-PRV6). */
const CONTENT_KEYS = [
  'gen_ai.input.messages',
  'gen_ai.input.messages_ref',
  'gen_ai.output.messages',
  'gen_ai.output.messages_ref',
  'gen_ai.system_instructions',
  'gen_ai.system_instructions_ref',
  'gen_ai.tool.definitions',
  'gen_ai.tool.definitions_ref',
  'gen_ai.prompt.variable',
];

/** All of a span that a sink could ever read, as one string to search for a canary. */
function everythingOf(span: ReadableSpan): string {
  return JSON.stringify({
    name: span.name,
    attributes: span.attributes,
    events: span.events,
    links: span.links,
    status: span.status,
    resource: span.resource.attributes,
    scope: span.instrumentationScope,
  });
}

describe('one structured call', () => {
  it('is one CLIENT span named chat {model} with the attributes of the conventions', async () => {
    const h = harness();
    await runStructured(h.deps, 'resume.tailor', {
      ...call,
      promptId: 'prompt-row-1',
      promptVersion: '3',
    });

    const span = only();
    const policy = DEFAULT_POLICIES['resume.tailor'];
    expect(span.name).toBe(`chat ${policy.model}`);
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.attributes).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'anthropic',
      'opportun.ai.provider': 'anthropic',
      'gen_ai.request.model': policy.model,
      'gen_ai.response.model': 'claude-opus-5-5-20260101',
      'gen_ai.request.max_tokens': policy.maxOutputTokens,
      ...(policy.temperature === undefined ? {} : { 'gen_ai.request.temperature': policy.temperature }),
      'gen_ai.output.type': 'json',
      'gen_ai.prompt.name': 'resume.tailor',
      'gen_ai.prompt.version': '3',
      'opportun.ai.prompt.id': 'prompt-row-1',
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.usage.output_tokens': 50,
      'gen_ai.response.id': 'resp_123',
      'gen_ai.response.finish_reasons': ['stop'],
      'opportun.ai.task': 'resume.tailor',
      'opportun.ai.feature': 'resume_tailoring',
      'opportun.ai.attempts': 1,
      'opportun.gen_ai.usage.cost': estimateCostUsd(policy.provider, policy.model, 100, 50),
      'user.id': 'user-1',
    });
  });

  it('has no stream attribute, no prompt version and no prompt id when none was given', async () => {
    const h = harness();
    await runStructured(h.deps, 'resume.match', call);
    const keys = Object.keys(only().attributes);
    expect(keys).not.toContain('gen_ai.request.stream');
    expect(keys).not.toContain('gen_ai.prompt.version');
    expect(keys).not.toContain('opportun.ai.prompt.id');
    expect(keys).not.toContain('gen_ai.response.time_to_first_chunk');
    expect(keys).not.toContain('gen_ai.conversation.id');
  });

  it('names the provider of the wire format: an OpenAI-compatible endpoint is openai', async () => {
    const override: ModelPolicy = {
      provider: 'openai_compatible',
      model: 'llama-local',
      maxOutputTokens: 500,
      baseUrl: 'https://llm.example.com/v1',
    };
    const h = harness({ overrides: { 'comms.classify': override } });
    await runStructured(h.deps, 'comms.classify', call);
    expect(only().attributes).toMatchObject({
      'gen_ai.provider.name': 'openai',
      'opportun.ai.provider': 'openai_compatible',
      'opportun.ai.feature': 'mail',
    });
  });

  it('puts cache tokens on the span only when the provider reports them and they are not zero', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: ok('{"score":1}', {
        usage: {
          inputTokens: { total: 100, noCache: 60, cacheRead: 30, cacheWrite: 10 },
          outputTokens: { total: 50, text: 50, reasoning: 0 },
        },
      }),
    });
    const h = harness({ model });
    await runStructured(h.deps, 'resume.match', call);
    expect(only().attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.usage.cache_read.input_tokens': 30,
      'gen_ai.usage.cache_write.input_tokens': 10,
    });

    exporter.reset();
    const h2 = harness();
    await runStructured(h2.deps, 'resume.match', call);
    expect(Object.keys(only().attributes)).not.toContain('gen_ai.usage.cache_read.input_tokens');
    expect(Object.keys(only().attributes)).not.toContain('gen_ai.usage.cache_write.input_tokens');
  });

  it('the schema retry and its two provider calls are inside one span, with both billed', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [ok('{"score":"high"}'), ok('{"score":2}')],
    });
    const h = harness({ model });
    await runStructured(h.deps, 'resume.match', call);
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(only().attributes).toMatchObject({
      'opportun.ai.attempts': 2,
      'gen_ai.usage.input_tokens': 200,
      'gen_ai.usage.output_tokens': 100,
    });
    expect(h.runs[0]).toMatchObject({ inputTokens: 200, outputTokens: 100 });
  });

  it('a span and its task_runs row tell the same story: tokens and cost agree', async () => {
    const h = harness();
    await runStructured(h.deps, 'discovery.rank', call);
    const rec = h.runs[0]!;
    expect(only().attributes).toMatchObject({
      'gen_ai.usage.input_tokens': rec.inputTokens,
      'gen_ai.usage.output_tokens': rec.outputTokens,
      'opportun.gen_ai.usage.cost': rec.estCostUsd,
    });
  });

  it('runs the provider call inside the span, so a request under it is its child', async () => {
    let activeInside: string | undefined;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        activeInside = trace.getActiveSpan()?.spanContext().spanId;
        return ok('{"score":1}');
      },
    });
    const h = harness({ model });
    await runStructured(h.deps, 'resume.match', call);
    expect(activeInside).toBeDefined();
    expect(activeInside).toBe(only().spanContext().spanId);
  });

  it('ends the span even when the ledger write fails, and before the ledger write', async () => {
    const h = harness();
    let endedWhenRecording = false;
    h.deps.record = async () => {
      endedWhenRecording = finished().length === 1;
      throw new Error('db unavailable');
    };
    await expect(runStructured(h.deps, 'resume.match', call)).rejects.toThrow('db unavailable');
    expect(endedWhenRecording).toBe(true);
    expect(finished()).toHaveLength(1);
  });
});

describe('a call that fails', () => {
  it('a budget refusal still gets a span with error.type and nothing from a provider', async () => {
    const h = harness({ spent: 99 });
    await expect(runStructured(h.deps, 'resume.match', call)).rejects.toMatchObject({
      reason: 'budget_exceeded',
    });
    const span = only();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes).toMatchObject({
      'error.type': 'budget_exceeded',
      'opportun.ai.task': 'resume.match',
      'gen_ai.request.model': DEFAULT_POLICIES['resume.match'].model,
    });
    const keys = Object.keys(span.attributes);
    for (const absent of [
      'gen_ai.response.model',
      'gen_ai.response.id',
      'gen_ai.response.finish_reasons',
    ]) {
      expect(keys).not.toContain(absent);
    }
    expect(h.model.doGenerateCalls).toHaveLength(0);
  });

  it('a missing key still gets a span with error.type no_key', async () => {
    const h = harness({ hasKey: false });
    await expect(runStructured(h.deps, 'resume.match', call)).rejects.toMatchObject({
      reason: 'no_key',
    });
    expect(only().attributes).toMatchObject({ 'error.type': 'no_key' });
    expect(only().status.code).toBe(SpanStatusCode.ERROR);
  });

  it('a provider error is error.type provider_error, with neither its text nor an exception event', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({
          message: `quota exceeded for ${CANARY}`,
          url: 'https://api.anthropic.com/v1/messages',
          requestBodyValues: { prompt: CANARY },
          statusCode: 429,
          responseBody: `{"error":"${CANARY}"}`,
          isRetryable: false,
        });
      },
    });
    const h = harness({ model });
    await expect(runStructured(h.deps, 'resume.match', call)).rejects.toBeInstanceOf(
      AiUnavailableError,
    );
    const span = only();
    expect(span.attributes).toMatchObject({ 'error.type': 'provider_error' });
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBeUndefined();
    expect(span.events).toEqual([]);
    expect(everythingOf(span)).not.toContain('CANARY');
    expect(everythingOf(span)).not.toContain(KEY);
  });

  it('schema-invalid output twice is error.type invalid_output after two attempts', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [ok('{"score":"high"}'), ok('not json')],
    });
    const h = harness({ model });
    await expect(runStructured(h.deps, 'resume.match', call)).rejects.toMatchObject({
      reason: 'invalid_output',
    });
    expect(only().attributes).toMatchObject({
      'error.type': 'invalid_output',
      'opportun.ai.attempts': 2,
      'gen_ai.usage.input_tokens': 200,
    });
  });

  it('a provider that cannot be built (an unsafe baseUrl) is provider_error on a span too', async () => {
    const h = harness();
    vi.mocked(createLanguageModel).mockImplementation(() => {
      throw new Error(`bad url ${CANARY}`);
    });
    await expect(runStructured(h.deps, 'resume.match', call)).rejects.toMatchObject({
      reason: 'provider_error',
    });
    expect(only().attributes).toMatchObject({ 'error.type': 'provider_error' });
    expect(everythingOf(only())).not.toContain('CANARY');
  });

  it('every call ends exactly one span, successes and failures alike', async () => {
    const h = harness();
    await runStructured(h.deps, 'resume.match', call);
    const refused = harness({ spent: 99 });
    await runStructured(refused.deps, 'resume.match', call).catch(() => undefined);
    const noKey = harness({ hasKey: false });
    await runStructured(noKey.deps, 'resume.match', call).catch(() => undefined);
    expect(finished()).toHaveLength(3);
    expect(h.runs.length + refused.runs.length + noKey.runs.length).toBe(3);
  });
});

describe('model names', () => {
  const policy = (model: string): ModelPolicy => ({
    provider: 'openai_compatible',
    model,
    maxOutputTokens: 100,
    baseUrl: 'https://llm.example.com/v1',
  });

  it('a model id with one slash is in the name and the attribute', async () => {
    const h = harness({ overrides: { 'comms.classify': policy('my-org/llama-3.1:70b') } });
    await runStructured(h.deps, 'comms.classify', call);
    expect(only().name).toBe('chat my-org/llama-3.1:70b');
    expect(only().attributes).toMatchObject({ 'gen_ai.request.model': 'my-org/llama-3.1:70b' });
  });

  it.each(['/etc/passwd', 'a/b/c', 'two words', `${'m'.repeat(129)}`, 'C:\\models\\x', 'a/'])(
    'a model that is not shaped like a model id (%s) gives the span name "chat" and _OTHER',
    async (model) => {
      exporter.reset();
      const h = harness({ overrides: { 'comms.classify': policy(model) } });
      await runStructured(h.deps, 'comms.classify', call);
      expect(only().name).toBe('chat');
      expect(only().attributes).toMatchObject({ 'gen_ai.request.model': '_OTHER' });
      expect(everythingOf(only())).not.toContain(model);
    },
  );

  it('a response model that is not shaped like a model id is _OTHER too', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: ok('{"score":1}', { response: { id: 'r1', modelId: '/srv/models/private' } }),
    });
    const h = harness({ model });
    await runStructured(h.deps, 'resume.match', call);
    expect(only().attributes).toMatchObject({ 'gen_ai.response.model': '_OTHER' });
  });
});

describe('a streamed call', () => {
  it('is one span that ends when the stream ends, with the streaming attributes', async () => {
    const h = harness({ model: streamModel('Hello there', { initialDelayInMs: 20 }) });
    const res = await streamChat(h.deps, 'resume.tailor', {
      ...chatCall,
      promptId: 'p9',
      conversationId: 'session-7',
    });
    // The budget and the key are checked, the stream is open, and nothing has ended yet.
    expect(finished()).toHaveLength(0);
    expect(await drain(res)).toBe('Hello there');

    const span = only();
    const policy = DEFAULT_POLICIES['resume.tailor'];
    expect(span.name).toBe(`chat ${policy.model}`);
    expect(span.kind).toBe(SpanKind.CLIENT);
    const { 'gen_ai.response.time_to_first_chunk': ttfc, ...rest } = span.attributes;
    expect(rest).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'anthropic',
      'opportun.ai.provider': 'anthropic',
      'gen_ai.request.model': policy.model,
      'gen_ai.response.model': 'claude-opus-5-5-20260101',
      'gen_ai.request.max_tokens': policy.maxOutputTokens,
      ...(policy.temperature === undefined ? {} : { 'gen_ai.request.temperature': policy.temperature }),
      'gen_ai.request.stream': true,
      'gen_ai.output.type': 'text',
      'gen_ai.prompt.name': 'resume.tailor',
      'opportun.ai.prompt.id': 'p9',
      'gen_ai.conversation.id': 'session-7',
      'gen_ai.usage.input_tokens': 30,
      'gen_ai.usage.output_tokens': 7,
      'gen_ai.response.id': 'resp_stream_1',
      'gen_ai.response.finish_reasons': ['stop'],
      'opportun.ai.task': 'resume.tailor',
      'opportun.ai.feature': 'resume_tailoring',
      'opportun.ai.attempts': 1,
      'opportun.gen_ai.usage.cost': estimateCostUsd(policy.provider, policy.model, 30, 7),
      'user.id': 'user-1',
    });
    // Seconds, not milliseconds: the mock waits 20 ms before its first chunk.
    expect(ttfc).toBeTypeOf('number');
    expect(ttfc as number).toBeGreaterThanOrEqual(0.015);
    expect(ttfc as number).toBeLessThan(2);
  });

  it('the span has ended by the time a full drain completes, even when the ledger write is slow', async () => {
    const h = harness({ model: streamModel('Hello there') });
    h.deps.record = async (run) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      h.runs.push(run);
    };
    const res = await streamChat(h.deps, 'resume.tailor', chatCall);
    await drain(res);
    expect(finished()).toHaveLength(1);
    expect(h.runs).toHaveLength(1);
  });

  it('a stream that errors ends its span with error.type provider_error and no text of the error', async () => {
    const chunks: LanguageModelV4StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'error', error: new Error(`overloaded: ${CANARY}`) },
    ];
    const model = new MockLanguageModelV4({
      doStream: { stream: simulateReadableStream({ chunks }) },
    });
    const h = harness({ model });
    const res = await streamChat(h.deps, 'resume.tailor', chatCall);
    await drain(res).catch(() => undefined);
    await vi.waitFor(() => expect(finished()).toHaveLength(1));
    const span = only();
    expect(span.attributes).toMatchObject({ 'error.type': 'provider_error' });
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events).toEqual([]);
    expect(everythingOf(span)).not.toContain('CANARY');
    expect(h.runs).toEqual([expect.objectContaining({ status: 'error' })]);
  });

  it('a budget refusal before the stream opens still gets a span with error.type', async () => {
    const h = harness({ model: streamModel('x'), spent: 99 });
    await expect(streamChat(h.deps, 'resume.tailor', chatCall)).rejects.toMatchObject({
      reason: 'budget_exceeded',
    });
    expect(only().attributes).toMatchObject({
      'error.type': 'budget_exceeded',
      'gen_ai.request.stream': true,
    });
  });

  it('a ledger failure goes to onRecordError, not the console, and the span still ends', async () => {
    const onRecordError = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const h = harness({ model: streamModel('Hello'), onRecordError });
      h.deps.record = async () => {
        throw new Error('db unavailable');
      };
      const res = await streamChat(h.deps, 'resume.tailor', chatCall);
      expect(await drain(res)).toBe('Hello');
      expect(onRecordError).toHaveBeenCalledWith('resume.tailor', expect.any(Error));
      expect(consoleError).not.toHaveBeenCalled();
      expect(finished()).toHaveLength(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('without onRecordError a ledger failure is swallowed in silence: the router does no IO', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const h = harness({ model: streamModel('Hello') });
      h.deps.record = async () => {
        throw new Error('db unavailable');
      };
      const res = await streamChat(h.deps, 'resume.tailor', chatCall);
      expect(await drain(res)).toBe('Hello');
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('an onRecordError that throws does not break the stream', async () => {
    const h = harness({
      model: streamModel('Hello'),
      onRecordError: () => {
        throw new Error('logger is broken');
      },
    });
    h.deps.record = async () => {
      throw new Error('db unavailable');
    };
    const res = await streamChat(h.deps, 'resume.tailor', chatCall);
    expect(await drain(res)).toBe('Hello');
  });
});

describe('content is never on a span', () => {
  async function runEverything(): Promise<void> {
    const content = {
      system: `System prompt for ${CANARY}`,
      prompt: `Resume of ${CANARY}`,
      schema: z.object({ score: z.number(), note: z.string().optional() }),
    };
    const model = new MockLanguageModelV4({
      doGenerate: ok(JSON.stringify({ score: 1, note: `Contact ${CANARY}` })),
    });
    await runStructured(harness({ model }).deps, 'resume.tailor', {
      ...content,
      promptId: 'p1',
      promptVersion: '2',
    });
    const res = await streamChat(harness({ model: streamModel(`Dear ${CANARY}`) }).deps, 'resume.tailor', {
      system: `System ${CANARY}`,
      messages: [{ role: 'user', content: `Please tailor for ${CANARY}` }],
      conversationId: 'session-1',
    });
    await drain(res);
    // After harness(), which installs its own mock model: from here every call fails.
    const failing = harness().deps;
    vi.mocked(createLanguageModel).mockReturnValue(
      new MockLanguageModelV4({
        doGenerate: async () => {
          throw new Error(`provider said: ${CANARY}`);
        },
      }),
    );
    await runStructured(failing, 'resume.match', content).catch(() => undefined);
    await pingModel('anthropic', 'claude-haiku-5-5', KEY, PROVIDER_FETCH);
  }

  it('no span of a structured call, a stream, a failure or a key check holds the content', async () => {
    await runEverything();
    const spans = finished();
    expect(spans.length).toBeGreaterThanOrEqual(4);
    for (const span of spans) {
      const text = everythingOf(span);
      expect(text, span.name).not.toContain('CANARY');
      expect(text, span.name).not.toContain('Resume of');
      expect(text, span.name).not.toContain(KEY);
      expect(span.events, span.name).toEqual([]);
      expect(span.links, span.name).toEqual([]);
      expect(span.status.message, span.name).toBeUndefined();
    }
  });

  it('no content attribute of the conventions is ever set', async () => {
    await runEverything();
    for (const span of finished()) {
      for (const key of CONTENT_KEYS) expect(span.attributes, span.name).not.toHaveProperty(key);
    }
  });

  it('a span carries only the attribute keys of the allowlist, so a new key is a deliberate edit', async () => {
    await runEverything();
    for (const span of finished()) {
      for (const key of Object.keys(span.attributes)) {
        expect(ALLOWED_KEYS.has(key), `${span.name}: ${key}`).toBe(true);
      }
    }
  });
});

describe('one user per trace (design 14.6)', () => {
  const tracer = (): ReturnType<typeof trace.getTracer> => trace.getTracer('test');

  it('a call for the user in the context is a child of the span in the context', async () => {
    const h = harness({ userId: 'user-1' });
    await withUser('user-1', async () => {
      await tracer().startActiveSpan('invoke_workflow tailoring_chat', async (parent) => {
        await runStructured(h.deps, 'resume.match', call);
        parent.end();
      });
    });
    const spans = finished();
    const parent = spans.find((s) => s.name === 'invoke_workflow tailoring_chat')!;
    const inference = spans.find((s) => s.name.startsWith('chat '))!;
    expect(inference.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(inference.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  });

  it('a call for another user starts a new trace: one trace per user, one job over every user', async () => {
    await withUser('user-a', async () => {
      await tracer().startActiveSpan('job opportunity.dedupe_ai_pass', async (job) => {
        await runStructured(harness({ userId: 'user-b' }).deps, 'opportunity.dedupe', call);
        await runStructured(harness({ userId: 'user-c' }).deps, 'opportunity.dedupe', call);
        job.end();
      });
    });
    const spans = finished();
    const job = spans.find((s) => s.name === 'job opportunity.dedupe_ai_pass')!;
    const inferences = spans.filter((s) => s.name.startsWith('chat '));
    expect(inferences).toHaveLength(2);
    expect(new Set(inferences.map((s) => s.spanContext().traceId)).size).toBe(2);
    for (const s of inferences) {
      expect(s.spanContext().traceId).not.toBe(job.spanContext().traceId);
      expect(s.parentSpanContext).toBeUndefined();
    }
    expect(inferences.map((s) => s.attributes['user.id']).sort()).toEqual(['user-b', 'user-c']);
  });

  it('the new trace carries its own user, so what runs under it knows whose it is', async () => {
    let seen: string | undefined;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        seen = userInContext();
        return ok('{"score":1}');
      },
    });
    await withUser('user-a', () =>
      runStructured(harness({ model, userId: 'user-b' }).deps, 'opportunity.dedupe', call),
    );
    expect(seen).toBe('user-b');
  });

  it('a call from a context with no user, for a user, starts a new trace too', async () => {
    await tracer().startActiveSpan('job x', async (job) => {
      await runStructured(harness({ userId: 'user-b' }).deps, 'resume.match', call);
      job.end();
    });
    const inference = finished().find((s) => s.name.startsWith('chat '))!;
    expect(inference.parentSpanContext).toBeUndefined();
  });

  it('a caller that gives no user id has no user.id attribute and joins the trace in the context', async () => {
    await tracer().startActiveSpan('parent', async (parent) => {
      await runStructured(harness({ userId: null }).deps, 'resume.match', call);
      parent.end();
    });
    const spans = finished();
    const inference = spans.find((s) => s.name.startsWith('chat '))!;
    expect(Object.keys(inference.attributes)).not.toContain('user.id');
    expect(inference.parentSpanContext?.spanId).toBe(
      spans.find((s) => s.name === 'parent')!.spanContext().spanId,
    );
  });

  it('withUser leaves no user behind once it returns', () => {
    expect(userInContext()).toBeUndefined();
    withUser('user-z', () => expect(userInContext()).toBe('user-z'));
    expect(userInContext()).toBeUndefined();
  });
});

describe('a key check', () => {
  it('is the same span with task key_check, no feature, no cost and no attempts', async () => {
    const model = new MockLanguageModelV4({ doGenerate: ok('p') });
    vi.mocked(createLanguageModel).mockReturnValue(model);
    expect(await pingModel('anthropic', 'claude-haiku-5-5', KEY, PROVIDER_FETCH)).toEqual({
      ok: true,
    });
    const span = only();
    expect(span.name).toBe('chat claude-haiku-5-5');
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'anthropic',
      'opportun.ai.provider': 'anthropic',
      'gen_ai.request.model': 'claude-haiku-5-5',
      'gen_ai.response.model': 'claude-opus-5-5-20260101',
      'gen_ai.request.max_tokens': 1,
      'gen_ai.output.type': 'text',
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.usage.output_tokens': 50,
      'gen_ai.response.id': 'resp_123',
      'gen_ai.response.finish_reasons': ['stop'],
      'opportun.ai.task': 'key_check',
    });
  });

  it('a refused key is error.type provider_error, without the provider text', async () => {
    vi.mocked(createLanguageModel).mockReturnValue(
      new MockLanguageModelV4({
        doGenerate: async () => {
          throw new APICallError({
            message: `invalid x-api-key ${CANARY}`,
            url: 'https://api.anthropic.com/v1/messages',
            requestBodyValues: {},
            statusCode: 401,
            isRetryable: false,
          });
        },
      }),
    );
    expect(await pingModel('anthropic', 'claude-haiku-5-5', KEY, PROVIDER_FETCH)).toMatchObject({
      ok: false,
      kind: 'auth',
    });
    const span = only();
    expect(span.attributes).toMatchObject({
      'error.type': 'provider_error',
      'opportun.ai.task': 'key_check',
    });
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events).toEqual([]);
    expect(everythingOf(span)).not.toContain('CANARY');
  });

  it('a model that cannot be built (an unsafe baseUrl) is still one span with an error', async () => {
    const real = await vi.importActual<typeof import('./providers')>('./providers');
    vi.mocked(createLanguageModel).mockImplementation(real.createLanguageModel);
    const result = await pingModel('openai_compatible', 'm', KEY, {
      ...PROVIDER_FETCH,
      baseUrl: 'http://10.0.0.5',
    });
    expect(result).toMatchObject({ ok: false });
    expect(only().attributes).toMatchObject({
      'error.type': 'provider_error',
      'opportun.ai.task': 'key_check',
    });
  });

  it('takes the user from the context, when there is one', async () => {
    vi.mocked(createLanguageModel).mockReturnValue(new MockLanguageModelV4({ doGenerate: ok('p') }));
    await withUser('user-5', () => pingModel('anthropic', 'claude-haiku-5-5', KEY, PROVIDER_FETCH));
    expect(only().attributes).toMatchObject({ 'user.id': 'user-5' });
  });
});
