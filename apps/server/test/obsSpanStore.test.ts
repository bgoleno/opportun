// The tracer provider and the local span store (design.md 14.3, 14.6, 14.7, 14.8, 14.11;
// https://github.com/bgoleno/opportun/issues/344, FR-T4 part 2). With collection on, Gen AI spans
// and what is under them are kept in obs_spans, and each kept trace's obs_traces row sums them.
// A route or a sibling that merely contains the first Gen AI span is not kept. Nothing a prompt,
// an output or an error says reaches a row, and export gets no user's id and no unpriced model.
import {
  AiUnavailableError,
  DEFAULT_POLICIES,
  runStructured,
  streamChat,
  USER_CONTEXT_KEY,
  withUser,
} from '@opportun/ai';
import { context, ROOT_CONTEXT, SpanKind, trace, TraceFlags } from '@opentelemetry/api';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createLanguageModel } from '../../../packages/ai/src/providers';
import { obsMetricPoints, obsSpans, obsTraces } from '../src/db/schema';
import { runOpportunityDedupeAi } from '../src/jobs/opportunityDedupeAi';
import { buildAiDeps } from '../src/lib/ai';
import {
  attachExporter,
  flushNow,
  type GatedSpan,
  obs,
  setCollecting,
  type SpanExportSink,
} from '../src/obs';
import { flushSpans } from '../src/obs/tracing';
import { TRACE_SPAN_CAP } from '../src/obs/spanStore';
import { useApi } from './api';
import { countRows } from './db';
import type { TestClient } from './isolation';

vi.mock('../../../packages/ai/src/providers', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../packages/ai/src/providers')>();
  return { ...real, createLanguageModel: vi.fn() };
});

const boot = useApi();
type App = Awaited<ReturnType<typeof boot>>['app'];
const KEY = 'sk-ant-test-THIS-IS-A-SECRET-0123456789';
const CANARY = 'CANARY-Jane-Doe-jane.doe@example.com-555-0100';

function result(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: 'end_turn' },
    usage: {
      inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 20, text: 20, reasoning: 0 },
    },
    warnings: [],
    response: { id: 'msg_01', modelId: 'claude-haiku-5-5' },
  };
}

/** The model resume.match runs on by default; the mock reports Haiku as the response model. */
const MODEL = DEFAULT_POLICIES['resume.match'].model;

const call = {
  system: `sys ${CANARY}`,
  prompt: `prompt ${CANARY}`,
  schema: z.object({ s: z.string() }),
};

async function deps(app: App, userId: string) {
  const d = await buildAiDeps(app.db, { userId, isAdmin: false });
  d.getKey = async () => KEY;
  return d;
}

/** A workflow span for a user, as obs/workflow.ts starts one. */
function workflow<T>(userId: string, name: string, fn: () => Promise<T>): Promise<T> {
  return withUser(userId, () =>
    obs.span(
      'gen_ai.workflow',
      { 'gen_ai.operation.name': 'invoke_workflow', 'gen_ai.agent.name': name, 'user.id': userId },
      fn,
    ),
  );
}

/** The kept spans, parents before children (spans can start in the same millisecond). */
async function spans(app: App) {
  const all = await app.db.select().from(obsSpans).all();
  const ids = new Map(all.map((sp) => [sp.spanId, sp]));
  const depth = (sp: (typeof all)[number]): number => {
    const parent = sp.parentSpanId === null ? undefined : ids.get(sp.parentSpanId);
    return parent === undefined ? 0 : 1 + depth(parent);
  };
  return all.sort((x, y) => depth(x) - depth(y) || x.startedAt - y.startedAt);
}

async function traces(app: App) {
  return app.db.select().from(obsTraces).all();
}

beforeEach(() => {
  vi.mocked(createLanguageModel).mockReset();
  vi.mocked(createLanguageModel).mockReturnValue(
    new MockLanguageModelV4({ doGenerate: result(JSON.stringify({ s: `out ${CANARY}` })) }),
  );
});

afterEach(async () => {
  await setCollecting(false);
});

describe('the span store (#344)', () => {
  it('keeps a workflow and its inference span as one tree, and sums it in the trace row', async () => {
    const { app, a } = await boot();
    await setCollecting(true);
    await workflow(a.userId, 'capture', async () =>
      runStructured(await deps(app, a.userId), 'resume.match', call),
    );
    await flushSpans();

    const [wf, inf] = await spans(app);
    expect(wf).toMatchObject({
      name: 'invoke_workflow capture',
      kind: 'internal',
      status: 'ok',
      userId: a.userId,
      parentSpanId: null,
      task: null,
    });
    expect(inf).toMatchObject({
      name: `chat ${MODEL}`,
      kind: 'client',
      parentSpanId: wf!.spanId,
      traceId: wf!.traceId,
      userId: a.userId,
      task: 'resume.match',
      model: MODEL,
      provider: 'anthropic',
    });
    expect(inf!.attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.response.id': 'msg_01',
      'user.id': a.userId,
    });
    const [row] = await traces(app);
    expect(row).toMatchObject({
      traceId: wf!.traceId,
      userId: a.userId,
      workflow: 'capture',
      feature: 'matching',
      tasks: ['resume.match'],
      models: [MODEL],
      providers: ['anthropic'],
      inputTokens: 100,
      outputTokens: 20,
      spanCount: 2,
      errorCount: 0,
      status: 'ok',
      truncated: false,
    });
    expect(row!.estCost).toBeGreaterThan(0);
  });

  it('a call outside any workflow is a trace of one inference span', async () => {
    const { app, a } = await boot();
    await setCollecting(true);
    await withUser(a.userId, async () =>
      runStructured(await deps(app, a.userId), 'resume.match', call),
    );
    await flushSpans();
    expect((await spans(app)).map((s) => s.name)).toEqual([`chat ${MODEL}`]);
    expect(await traces(app)).toEqual([
      expect.objectContaining({ workflow: null, spanCount: 1, userId: a.userId }),
    ]);
  });

  it('a failed call keeps its error.type, counts as an error, and keeps no text of the error', async () => {
    const { app, a } = await boot();
    await setCollecting(true);
    vi.mocked(createLanguageModel).mockReturnValue(
      new MockLanguageModelV4({
        doGenerate: async () => {
          throw new APICallError({
            message: `quota for ${CANARY}`,
            url: 'https://api.anthropic.com/v1/messages',
            requestBodyValues: { prompt: CANARY },
            statusCode: 400,
            responseBody: CANARY,
            isRetryable: false,
          });
        },
      }),
    );
    await workflow(a.userId, 'mail_sync', async () =>
      runStructured(await deps(app, a.userId), 'comms.classify', call).catch(() => undefined),
    );
    await flushSpans();
    const inf = (await spans(app)).find((s) => s.kind === 'client');
    expect(inf).toMatchObject({ status: 'error', errorType: 'provider_error' });
    expect(await traces(app)).toEqual([
      expect.objectContaining({ errorCount: 1, status: 'error' }),
    ]);
  });

  it('keeps the provider request under an inference span, and nothing beside it', async () => {
    const { app, a } = await boot();
    await setCollecting(true);
    vi.mocked(createLanguageModel).mockReturnValue(
      new MockLanguageModelV4({
        doGenerate: async () => {
          // The observed provider fetch makes this span (obs/outbound.ts), inside the inference span.
          await obs.span(
            'http.client',
            { 'http.request.method': 'POST', 'opportun.outbound.target': 'anthropic' },
            async (s) => s.set({ 'http.response.status_code': 200 }),
          );
          return result('{"s":"x"}');
        },
      }),
    );
    // A route's span contains the workflow: it is not kept, and names the trace's origin.
    const route = trace.getTracer('test').startSpan('POST /api/v1/capture', {
      kind: SpanKind.SERVER,
      attributes: { 'http.route': '/api/v1/capture' },
    });
    await context.with(trace.setSpan(context.active(), route), async () => {
      await workflow(a.userId, 'capture', async () =>
        runStructured(await deps(app, a.userId), 'resume.match', call),
      );
      // A sibling after the workflow, inside the route: not kept.
      await obs.span('http.client', { 'http.request.method': 'GET' }, async () => undefined);
    });
    route.end();
    await flushSpans();

    const kept = await spans(app);
    expect(kept.map((s) => s.name)).toEqual(['invoke_workflow capture', `chat ${MODEL}`, 'POST']);
    expect(kept[2]!.parentSpanId).toBe(kept[1]!.spanId);
    expect(kept[2]!.attributes).toMatchObject({ 'opportun.outbound.target': 'anthropic' });
    expect(await traces(app)).toEqual([
      expect.objectContaining({ origin: '/api/v1/capture', spanCount: 3 }),
    ]);
  });

  it('keeps a span under a remote parent: a job that continues a trace (jobs.trace_context)', async () => {
    const { app, a } = await boot();
    await setCollecting(true);
    // What the runner builds from trace_context (#343): the stored parent, remote, with the user.
    const parent = trace.setSpanContext(ROOT_CONTEXT.setValue(USER_CONTEXT_KEY, a.userId), {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });
    await context.with(parent, () =>
      obs.span('http.client', { 'http.request.method': 'GET' }, async () => undefined),
    );
    await flushSpans();
    expect(await spans(app)).toEqual([
      expect.objectContaining({
        traceId: '0af7651916cd43dd8448eb211c80319c',
        parentSpanId: 'b7ad6b7169203331',
        userId: a.userId,
      }),
    ]);
  });

  it('drops a span that matches no catalogued name whole, and counts it', async () => {
    const { app, a } = await boot();
    await setCollecting(true);
    await workflow(a.userId, 'capture', async () => {
      trace.getTracer('some-dependency').startSpan(`lookup ${CANARY}`).end();
    });
    await flushSpans();
    await flushNow();
    expect((await spans(app)).map((s) => s.name)).toEqual(['invoke_workflow capture']);
    const dropped = await app.db
      .select()
      .from(obsMetricPoints)
      .where(eq(obsMetricPoints.metric, 'opportun.obs.dropped'))
      .all();
    expect(dropped.some((p) => p.attributes['opportun.obs.signal'] === 'spans')).toBe(true);
  });

  it('a call for another user inside a workflow starts that user’s own trace (14.6)', async () => {
    const { app, a, b } = await boot();
    await setCollecting(true);
    await workflow(a.userId, 'capture', async () =>
      runStructured(await deps(app, b.userId), 'resume.match', call),
    );
    await flushSpans();
    const rows = await traces(app);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([a.userId, b.userId]));
    for (const s of await spans(app)) {
      expect(s.userId).toBe(rows.find((r) => r.traceId === s.traceId)!.userId);
    }
  });

  it('a span for another user under a user\u2019s workflow is dropped, not mixed into the trace', async () => {
    const { app, a, b } = await boot();
    await setCollecting(true);
    await workflow(a.userId, 'capture', async () => {
      await withUser(b.userId, () =>
        obs.span('http.client', { 'http.request.method': 'GET' }, async () => undefined),
      );
    });
    await flushSpans();
    expect((await spans(app)).map((s) => [s.name, s.userId])).toEqual([
      ['invoke_workflow capture', a.userId],
    ]);
    expect(await traces(app)).toEqual([
      expect.objectContaining({ userId: a.userId, spanCount: 1 }),
    ]);
  });

  it('a streamed chat turn is one span with the conversation id, local only', async () => {
    const { app, a } = await boot();
    await setCollecting(true);
    vi.mocked(createLanguageModel).mockReturnValue(
      new MockLanguageModelV4({
        doStream: async () => ({
          stream: new ReadableStream({
            start(c) {
              c.enqueue({ type: 'text-start', id: 't' });
              c.enqueue({ type: 'text-delta', id: 't', delta: `Dear ${CANARY}` });
              c.enqueue({ type: 'text-end', id: 't' });
              c.enqueue({
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: {
                  inputTokens: { total: 9, noCache: 9, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 3, text: 3, reasoning: 0 },
                },
              });
              c.close();
            },
          }),
        }),
      }),
    );
    const session = '0d6f3c1e-8a2b-4c5d-9e7f-1a2b3c4d5e6f';
    await workflow(a.userId, 'tailoring_chat', async () => {
      const res = await streamChat(await deps(app, a.userId), 'resume.tailor', {
        system: `sys ${CANARY}`,
        messages: [{ role: 'user', content: CANARY }],
        conversationId: session,
      });
      for await (const d of res.textStream) void d;
    });
    await flushSpans();
    expect(await traces(app)).toEqual([
      expect.objectContaining({ workflow: 'tailoring_chat', conversationId: session }),
    ]);
    const inf = (await spans(app)).find((s) => s.kind === 'client')!;
    expect(inf.attributes).toMatchObject({
      'gen_ai.request.stream': true,
      'gen_ai.conversation.id': session,
    });
  });

  it('no row holds what a prompt, an output or an error said', async () => {
    const { app, a } = await boot();
    await setCollecting(true);
    await workflow(a.userId, 'capture', async () => {
      await runStructured(await deps(app, a.userId), 'resume.match', call);
      const failing = await deps(app, a.userId);
      failing.getKey = async () => {
        throw new AiUnavailableError('no_key', CANARY);
      };
      await runStructured(failing, 'resume.match', call).catch(() => undefined);
    });
    await flushSpans();
    const all = JSON.stringify([await spans(app), await traces(app)]);
    expect(all).not.toContain('CANARY');
    expect(all).not.toContain(KEY);
  });

  it('stops a trace at its span cap and marks it truncated (14.11)', async () => {
    const { app, a } = await boot();
    await setCollecting(true);
    await workflow(a.userId, 'discovery_run', async () => {
      for (let i = 0; i < TRACE_SPAN_CAP + 5; i++) {
        await obs.span('http.client', { 'http.request.method': 'GET' }, async () => undefined);
      }
    });
    await flushSpans();
    expect(await countRows(app, obsSpans)).toBe(TRACE_SPAN_CAP);
    expect(await traces(app)).toEqual([
      expect.objectContaining({
        spanCount: TRACE_SPAN_CAP,
        truncated: true,
        // The root ends last, and is kept anyway: the trace keeps its name and its root.
        workflow: 'discovery_run',
      }),
    ]);
    const stored = await spans(app);
    const root = stored.find((s) => s.name === 'invoke_workflow discovery_run');
    expect(root).toMatchObject({ parentSpanId: null });
    for (const s of stored) if (s !== root) expect(s.parentSpanId).toBe(root!.spanId);
  });
});

describe('one user per trace: opportunity.dedupe_ai_pass (#344, 14.6)', () => {
  // An instance job that works through every user's rows: each AI call is its own user's trace,
  // never a child of the job's span, so no trace holds two users.
  async function pendingPairFor(c: TestClient) {
    const key = await c.request({
      method: 'POST',
      url: '/api/v1/secrets',
      payload: { kind: 'ai_api_key', label: 'anthropic', value: KEY },
    });
    expect(key.statusCode).toBe(201);
    for (const [companyName, title] of [
      ['Acme Robotics', 'Senior Product Manager'],
      ['Acme Robotics, Inc.', 'Product Manager II'],
    ]) {
      const res = await c.request({
        method: 'POST',
        url: '/api/v1/opportunities',
        payload: { companyName, title, sourceKind: 'manual' },
      });
      expect(res.statusCode).toBe(201);
    }
  }

  it('each user\u2019s call starts that user\u2019s own trace, under no job span', async () => {
    const { app, a, b } = await boot();
    await pendingPairFor(a);
    await pendingPairFor(b);
    await setCollecting(true);
    // The instance job's own span (FR-T3's job span): it has no user.
    const job = trace.getTracer('test').startSpan('job opportunity.dedupe_ai_pass');
    await context.with(trace.setSpan(ROOT_CONTEXT, job), () =>
      runOpportunityDedupeAi(app.db, { log: { warn: () => undefined } }),
    );
    job.end();
    await flushSpans();
    const rows = await traces(app);
    expect(rows.map((r) => r.userId).sort()).toEqual([a.userId, b.userId].sort());
    const kept = await spans(app);
    expect(kept).toHaveLength(2);
    for (const s of kept) {
      expect(s.parentSpanId).toBeNull();
      expect(s.traceId).not.toBe(job.spanContext().traceId);
      expect(s.userId).toBe(rows.find((r) => r.traceId === s.traceId)!.userId);
    }
  });
});

describe('the traces dashboard reads what the store writes (#344 with #347)', () => {
  it('lists the stored trace for its user only, and shows its spans with their prompt', async () => {
    const { app, a, b } = await boot();
    await setCollecting(true);
    await workflow(a.userId, 'capture', async () =>
      runStructured(await deps(app, a.userId), 'resume.match', { ...call, promptVersion: 4 }),
    );
    await flushSpans();
    const list = await a.request({ method: 'GET', url: '/api/v1/obs/traces' });
    expect(list.statusCode, list.body).toBe(200);
    const items = (list.json() as { items: { traceId: string; workflow: string | null }[] }).items;
    expect(items).toEqual([expect.objectContaining({ workflow: 'capture' })]);
    const other = await b.request({ method: 'GET', url: '/api/v1/obs/traces' });
    expect((other.json() as { items: unknown[] }).items).toEqual([]);

    const detail = await a.request({
      method: 'GET',
      url: `/api/v1/obs/traces/${items[0]!.traceId}`,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const spansShown = (
      detail.json() as {
        spans: {
          spanId: string;
          parentSpanId: string | null;
          name: string;
          prompt: { name: string; version: number | null } | null;
        }[];
      }
    ).spans;
    // By nesting, not by list order: spans that start in the same millisecond come back in
    // span-id order, which is random.
    const wf = spansShown.find((s) => s.name === 'invoke_workflow capture');
    const inference = spansShown.find((s) => s.name === `chat ${MODEL}`);
    expect(spansShown).toHaveLength(2);
    expect(wf).toMatchObject({ parentSpanId: null });
    expect(inference).toMatchObject({
      parentSpanId: wf!.spanId,
      prompt: { name: 'resume.match', version: 4 },
    });
  });
});

describe('the export slot (#344, 14.8)', () => {
  it('gets each span rebuilt with no user id or response id, and only a priced model', async () => {
    const { app, a } = await boot();
    await setCollecting(true);
    const got: GatedSpan[] = [];
    const sink: SpanExportSink = { export: (s) => got.push(s), shutdown: async () => undefined };
    expect(attachExporter('spans', sink)).toBe(true);
    const d = await deps(app, a.userId);
    d.policyFor = async () => ({
      provider: 'openai_compatible',
      model: 'jane.doe',
      maxOutputTokens: 50,
      baseUrl: 'https://llm.example.com/v1',
    });
    await workflow(a.userId, 'capture', async () => {
      await runStructured(d, 'resume.match', call);
      await runStructured(await deps(app, a.userId), 'resume.match', call);
    });
    const [unpriced, priced, wf] = got;
    expect(wf).toMatchObject({ name: 'invoke_workflow capture', kind: 'internal' });
    expect(unpriced).toMatchObject({ name: 'chat', kind: 'client' });
    expect(unpriced!.attributes).toMatchObject({ 'gen_ai.request.model': '_OTHER' });
    expect(priced).toMatchObject({ name: `chat ${MODEL}` });
    for (const s of got) {
      expect(Object.keys(s.attributes)).not.toContain('user.id');
      expect(Object.keys(s.attributes)).not.toContain('gen_ai.conversation.id');
      expect(Object.keys(s.attributes)).not.toContain('opportun.ai.prompt.id');
      expect(Object.keys(s.attributes)).not.toContain('gen_ai.response.id');
      expect(JSON.stringify(s)).not.toContain(a.userId);
      expect(JSON.stringify(s)).not.toContain('jane.doe');
    }
  });
});

describe('with collection off (#344, 14.11)', () => {
  it('no span records and no row is written, the SDK unloaded or not', async () => {
    const { app, a } = await boot();
    let recording: boolean | undefined;
    await workflow(a.userId, 'capture', async () => {
      recording = trace.getActiveSpan()?.isRecording();
      await runStructured(await deps(app, a.userId), 'resume.match', call);
    });
    await flushSpans();
    expect(recording).not.toBe(true);
    expect(await countRows(app, obsSpans)).toBe(0);
    expect(await countRows(app, obsTraces)).toBe(0);
  });

  it('turned off after being on, it records nothing again and drops what waited', async () => {
    const { app, a } = await boot();
    await setCollecting(true);
    await workflow(a.userId, 'capture', async () => undefined);
    await setCollecting(false);
    let recording: boolean | undefined;
    await workflow(a.userId, 'capture', async () => {
      recording = trace.getActiveSpan()?.isRecording();
    });
    await flushSpans();
    expect(recording).not.toBe(true);
    expect(await countRows(app, obsSpans)).toBe(0);
  });
});
