// The AI SDK's own telemetry stays off (https://github.com/bgoleno/opportun/issues/344, design
// 14.5). It records prompts and responses by default, under names that are not the Gen AI
// conventions', and it turns itself on once a telemetry integration is registered. Four checks:
//   1. every generateText and streamText call passes telemetry off (and no input or output
//      recording), and never the older experimental_telemetry;
//   2. nothing in this package registers an integration;
//   3. a subscriber on the SDK's `ai:telemetry` diagnostics channel, which an APM agent preloaded by
//      an operator can be, with no integration registered at all, hears nothing from a call. The
//      channel is a separate path from the integrations: without the opt-out it carries prompts;
//   4. with an integration registered anyway (as a dependency or the server might), a router call
//      and a key check reach none of its hooks. A control shows the same integration does hear a
//      call that does not opt out, so check 4 cannot pass just because the integration is deaf.
//
// The SDK keeps its list of integrations in a global it has no way to empty again, so the tests
// that register one come last in this file: keep them out of a file that other tests share.
import { tracingChannel } from 'node:diagnostics_channel';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { generateText, registerTelemetry, streamText, type Telemetry } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { pingModel } from './keyCheck';
import { resolvePolicy } from './policies';
import { createLanguageModel } from './providers';
import { runStructured, streamChat } from './router';
import { AiUnavailableError, type AiDeps } from './types';

vi.mock('ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('ai')>();
  return {
    ...real,
    generateText: vi.fn(real.generateText),
    streamText: vi.fn(real.streamText),
  };
});
vi.mock('./providers', async (importOriginal) => {
  const real = await importOriginal<typeof import('./providers')>();
  return { ...real, createLanguageModel: vi.fn() };
});

const PROVIDER_FETCH = {
  fetch: (() => Promise.reject(new Error('unused: createLanguageModel is mocked'))) as typeof fetch,
  allowLoopbackHttp: false,
};

const heard: string[] = [];
const listen = (hook: string) => (): void => {
  heard.push(hook);
};
// Every hook of the SDK's Telemetry interface. The two that wrap work hand it straight back.
const integration: Telemetry = {
  onStart: listen('onStart'),
  onStepStart: listen('onStepStart'),
  onLanguageModelCallStart: listen('onLanguageModelCallStart'),
  onLanguageModelCallEnd: listen('onLanguageModelCallEnd'),
  onToolExecutionStart: listen('onToolExecutionStart'),
  onToolExecutionEnd: listen('onToolExecutionEnd'),
  onStepEnd: listen('onStepEnd'),
  onStepFinish: listen('onStepFinish'),
  onObjectStepStart: listen('onObjectStepStart'),
  onObjectStepEnd: listen('onObjectStepEnd'),
  onEmbedStart: listen('onEmbedStart'),
  onEmbedEnd: listen('onEmbedEnd'),
  onRerankStart: listen('onRerankStart'),
  onRerankEnd: listen('onRerankEnd'),
  onEnd: listen('onEnd'),
  onAbort: listen('onAbort'),
  onError: listen('onError'),
  executeLanguageModelCall: (options) => {
    heard.push('executeLanguageModelCall');
    return options.execute();
  },
  executeTool: (options) => {
    heard.push('executeTool');
    return options.execute();
  },
};

function model(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'text', text: '{"score":1}' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 2, text: 2, reasoning: 0 },
      },
      warnings: [],
    },
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'text-start', id: 't' });
          controller.enqueue({ type: 'text-delta', id: 't', delta: 'hi' });
          controller.enqueue({ type: 'text-end', id: 't' });
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 2, text: 2, reasoning: 0 },
            },
          });
          controller.close();
        },
      }),
    }),
  });
}

function deps(): AiDeps {
  vi.mocked(createLanguageModel).mockReturnValue(model());
  return {
    getKey: async () => {
      throw new AiUnavailableError('no_key');
    },
    policyFor: async (task) => resolvePolicy(task, undefined),
    record: async () => undefined,
    budget: { perTaskDailyUsd: 5 },
    spentTodayUsd: async () => 0,
    providerFetch: PROVIDER_FETCH,
  };
}

async function allThree(): Promise<void> {
  const d = deps();
  d.getKey = async () => 'sk-test-key-0123456789';
  await runStructured(d, 'resume.match', {
    system: 's',
    prompt: 'p',
    schema: z.object({ score: z.number() }),
  });
  const res = await streamChat(d, 'resume.tailor', {
    system: 's',
    messages: [{ role: 'user', content: 'hi' }],
  });
  for await (const delta of res.textStream) void delta;
  await pingModel('anthropic', 'claude-haiku-5-5', 'sk-test-key-0123456789', PROVIDER_FETCH);
}

beforeEach(() => {
  heard.length = 0;
  vi.mocked(generateText).mockClear();
  vi.mocked(streamText).mockClear();
});

describe('every call to the SDK passes its telemetry off', () => {
  it('runStructured, streamChat and a key check: isEnabled false, nothing recorded', async () => {
    await allThree();
    const calls = [...vi.mocked(generateText).mock.calls, ...vi.mocked(streamText).mock.calls];
    // runStructured and the key check use generateText; streamChat uses streamText.
    expect(vi.mocked(generateText).mock.calls).toHaveLength(2);
    expect(vi.mocked(streamText).mock.calls).toHaveLength(1);
    for (const [options] of calls) {
      expect(options.telemetry).toEqual({
        isEnabled: false,
        recordInputs: false,
        recordOutputs: false,
      });
      expect(options).not.toHaveProperty('experimental_telemetry');
    }
  });
});

describe('nothing in this package turns the SDK telemetry on', () => {
  it('no source file registers an integration or passes the older option', () => {
    const dir = import.meta.dirname;
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(sources.length).toBeGreaterThan(5);
    for (const file of sources) {
      const text = readFileSync(join(dir, file), 'utf8');
      expect(text, file).not.toContain('registerTelemetry');
      expect(text, file).not.toContain('experimental_telemetry');
      expect(text, file).not.toMatch(/isEnabled:\s*true/);
    }
  });
});

describe('the SDK diagnostics channel, with no integration registered', () => {
  // `ai:telemetry` publishes a call's prompts to any subscriber when telemetry is not off, whether
  // or not an integration was registered. A subscriber of its own is how this test hears it.
  const CANARY = 'CANARY-Jane-Doe-jane.doe@example.com-555-0100';
  const channel = tracingChannel('ai:telemetry');
  const published: string[] = [];
  const subscriber = {
    start: (message: unknown) =>
      published.push(inspect(message, { depth: 8, maxStringLength: null })),
    end: (message: unknown) =>
      published.push(inspect(message, { depth: 8, maxStringLength: null })),
    asyncStart: (message: unknown) =>
      published.push(inspect(message, { depth: 8, maxStringLength: null })),
    asyncEnd: (message: unknown) =>
      published.push(inspect(message, { depth: 8, maxStringLength: null })),
    error: (message: unknown) =>
      published.push(inspect(message, { depth: 8, maxStringLength: null })),
  };

  beforeEach(() => {
    published.length = 0;
    channel.subscribe(subscriber);
    return () => channel.unsubscribe(subscriber);
  });

  it('a call that does not opt out publishes its prompt on the channel (the control)', async () => {
    await generateText({ model: model(), prompt: `Resume of ${CANARY}` });
    expect(published.length).toBeGreaterThan(0);
    expect(published.join('\n')).toContain(CANARY);
  });

  it('a router call, a stream and a key check publish nothing on it', async () => {
    const d = deps();
    d.getKey = async () => 'sk-test-key-0123456789';
    await runStructured(d, 'resume.match', {
      system: `System ${CANARY}`,
      prompt: `Resume of ${CANARY}`,
      schema: z.object({ score: z.number() }),
    });
    const res = await streamChat(d, 'resume.tailor', {
      system: `System ${CANARY}`,
      messages: [{ role: 'user', content: `Tailor for ${CANARY}` }],
    });
    for await (const delta of res.textStream) void delta;
    await pingModel('anthropic', 'claude-haiku-5-5', 'sk-test-key-0123456789', PROVIDER_FETCH);
    expect(published).toEqual([]);
  });
});

describe('with an integration registered anyway', () => {
  it('a call that does not opt out is heard by it (the control)', async () => {
    registerTelemetry(integration);
    await generateText({ model: model(), prompt: 'p' });
    expect(heard.length).toBeGreaterThan(0);
  });

  it('a router call, a stream and a key check reach none of its hooks', async () => {
    registerTelemetry(integration);
    await allThree();
    expect(heard).toEqual([]);
  });
});
