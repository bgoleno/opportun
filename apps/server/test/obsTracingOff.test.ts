// With collection off, the default, no tracer provider is registered and obs/tracing.ts (with the
// SDK) is never loaded (design.md 14.3, 14.11; https://github.com/bgoleno/opportun/issues/344). A
// file of its own: vitest isolates files, so nothing here turned collection on first.
import { ProxyTracerProvider, trace } from '@opentelemetry/api';
import { runStructured } from '@opportun/ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createLanguageModel } from '../../../packages/ai/src/providers';
import { obsSpans } from '../src/db/schema';
import { buildAiDeps } from '../src/lib/ai';
import { isCollecting } from '../src/obs';
import { workflow } from '../src/obs/workflow';
import { useApi } from './api';
import { countRows } from './db';

vi.mock('../../../packages/ai/src/providers', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../packages/ai/src/providers')>();
  return { ...real, createLanguageModel: vi.fn() };
});

const boot = useApi();

describe('collection off, the default (#344)', () => {
  it('a workflow and an AI call register no provider, record nothing and write nothing', async () => {
    const { app, a } = await boot();
    expect(isCollecting()).toBe(false);
    vi.mocked(createLanguageModel).mockReturnValue(
      new MockLanguageModelV4({
        doGenerate: {
          content: [{ type: 'text', text: '{"s":"x"}' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 2, text: 2, reasoning: 0 },
          },
          warnings: [],
        },
      }),
    );
    const deps = await buildAiDeps(app.db, { userId: a.userId, isAdmin: false });
    deps.getKey = async () => 'sk-test-key-0123456789';
    await workflow('capture', { userId: a.userId }, () =>
      runStructured(deps, 'resume.match', {
        system: 's',
        prompt: 'p',
        schema: z.object({ s: z.string() }),
      }),
    );
    // The API's global provider is still its own proxy with no SDK provider behind it.
    const provider = trace.getTracerProvider();
    expect(provider).toBeInstanceOf(ProxyTracerProvider);
    expect((provider as ProxyTracerProvider).getDelegate().constructor.name).toBe(
      'NoopTracerProvider',
    );
    expect(await countRows(app, obsSpans)).toBe(0);
  });
});
