// The cost with collection on (design.md 14.11; https://github.com/bgoleno/opportun/issues/343):
// under 20 microseconds per boundary crossing and under 2 per database statement after the
// first sight of its text, on average. A benchmark, reported in the PR, not a gate: timings
// vary by machine, so it runs only with OBS_BENCH=1 and prints its averages.
//
//   OBS_BENCH=1 OBS_BENCH_OUT=<file> npx vitest run test/obsBench.test.ts
//
// No tracer provider is registered (FR-T4 part 2's), so a span here costs what the API's
// no-op span costs; the provider's own cost is measured with that slice.
import { writeFileSync } from 'node:fs';
import { runStructured, withUser } from '@opportun/ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createLanguageModel } from '../../../packages/ai/src/providers';
import { buildAiDeps } from '../src/lib/ai';
import { obs, setCollecting } from '../src/obs';
import { observeStatement } from '../src/obs/database';
import { flushSpans } from '../src/obs/tracing';
import { useApi } from './api';

// A stub model, so an AI call reaches no network (as test/aiGenAiMetrics.test.ts does).
vi.mock('../../../packages/ai/src/providers', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../packages/ai/src/providers')>();
  return { ...real, createLanguageModel: vi.fn() };
});

const boot = useApi();
const RUN = process.env.OBS_BENCH === '1';

function perCallMicros(n: number, fn: (i: number) => void): number {
  for (let i = 0; i < 1_000; i += 1) fn(i); // warm up
  const started = performance.now();
  for (let i = 0; i < n; i += 1) fn(i);
  return ((performance.now() - started) * 1000) / n;
}

describe.runIf(RUN)('collection on: cost per call (#343, reported in the PR)', () => {
  it('measures each boundary', async () => {
    await boot();
    await setCollecting(true);
    const N = 200_000;
    const results = {
      // A database statement whose text was seen before: shape lookup, gate, aggregate.
      dbStatement: perCallMicros(N, () =>
        observeStatement('sqlite', 'select "id" from "companies" where "user_id" = ?', () => 0),
      ),
      // An HTTP request's share: open a span, record the metric with four attributes, end it.
      httpBoundary: perCallMicros(N, (i) => {
        const s = obs.startSpan('http.server', {
          'http.request.method': 'GET',
          'http.route': '/api/v1/opportunities/:id',
        });
        obs.record('http.server.request.duration', 0.01, {
          'http.request.method': 'GET',
          'http.route': '/api/v1/opportunities/:id',
          'http.response.status_code': i % 10 === 0 ? 500 : 200,
        });
        s.end();
      }),
    };
    // Vitest hides a passing test's console: OBS_BENCH_OUT names a file for the numbers.
    const out = process.env.OBS_BENCH_OUT;
    if (out !== undefined) writeFileSync(out, `${JSON.stringify(results)}\n`);
    else console.log('obs bench (microseconds per call)', JSON.stringify(results));
    expect(results.dbStatement).toBeLessThan(2);
    expect(results.httpBoundary).toBeLessThan(20);
    await setCollecting(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Whole operations, collection off against on (design.md 14.11; https://github.com/bgoleno/opportun/issues/374).
// A crossing measured alone leaves out what a whole request adds around it: the plugin's hooks,
// the context switches around the handler, the statements and the garbage. So these run whole
// operations in alternated batches, collection off then on, in one process and one database, and
// report process CPU time per operation as the median of the pairs' differences: the machine is
// shared, and only alternation cancels its noise. The method is qa's
// (qa-tools/qa-bench1411.test.ts, reported on #374). Turning collection on registers the real
// tracer provider and span store (#366); the span flush is outside the request path and is
// #375's to bound, so it runs between batches and is not counted.

const PAIRS = 30;
// Under SPAN_FLUSH_AT (200, obs/spanStore.ts): an AI call keeps one span (a request's span is not
// kept, 14.7), so a batch of 200 AI calls would trigger a span flush inside the timed region and
// count the flush as part of each call. This benchmark's first version did, at exactly 200 (#374).
// Flushes run between batches and are timed apart.
const BATCH = 150;
const cpuMicros = (): number => {
  const u = process.cpuUsage();
  return u.user + u.system;
};
const median = (xs: readonly number[]): number =>
  [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] ?? Number.NaN;
const round = (x: number): number => Math.round(x * 10) / 10;

async function perOperation(k: number, fn: () => Promise<unknown>): Promise<number> {
  const started = cpuMicros();
  for (let i = 0; i < k; i += 1) await fn();
  return (cpuMicros() - started) / k;
}

/**
 * Alternated off/on batches: the medians, the median of the pairs' differences, and the span
 * flush that follows each on batch, timed on its own and given per span (it is #375's to bound,
 * not part of a request's or a call's path).
 */
async function alternate(fn: () => Promise<unknown>) {
  const off: number[] = [];
  const on: number[] = [];
  const flush: number[] = [];
  for (let r = 0; r < PAIRS; r += 1) {
    await setCollecting(false);
    off.push(await perOperation(BATCH, fn));
    await setCollecting(true);
    await flushSpans();
    on.push(await perOperation(BATCH, fn));
    const started = cpuMicros();
    await flushSpans();
    flush.push((cpuMicros() - started) / BATCH);
  }
  await setCollecting(false);
  return {
    offUs: round(median(off)),
    onUs: round(median(on)),
    addedUs: round(median(on.map((x, i) => x - (off.at(i) ?? 0)))),
    spanFlushUsPerSpan: round(median(flush)),
  };
}

function modelAnswer(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: 'end_turn' },
    usage: {
      inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 20, text: 20, reasoning: 0 },
    },
    warnings: [],
    response: { id: 'msg_bench', modelId: 'claude-haiku-5-5' },
  };
}

describe.runIf(RUN)(
  'collection off against on, whole operations (#374, reported in the PR)',
  () => {
    it('a whole request and an AI call: CPU per operation, and what collection adds', async () => {
      const { app, a } = await boot();
      // A request: GET /api/v1/opportunities/:id, one HTTP crossing and its statements.
      const made = await a.request({
        method: 'POST',
        url: '/api/v1/opportunities',
        payload: { companyName: 'Bench Co', title: 'Role', sourceKind: 'manual' },
      });
      const id = (made.json() as { id: string }).id;
      const request = () => a.request({ method: 'GET', url: `/api/v1/opportunities/${id}` });
      // An AI call: runStructured with a stub model, through the router, the budget check and the
      // task_runs ledger, as a request or a job makes it.
      vi.mocked(createLanguageModel).mockImplementation(
        () =>
          new MockLanguageModelV4({ doGenerate: modelAnswer(JSON.stringify({ s: 'x' })) }) as never,
      );
      const deps = await buildAiDeps(app.db, { userId: a.userId, isAdmin: false });
      deps.getKey = async () => 'bench-key';
      deps.spentTodayUsd = async () => 0;
      const call = { system: 'sys', prompt: 'prompt', schema: z.object({ s: z.string() }) };
      const ai = () => withUser(a.userId, () => runStructured(deps, 'resume.match', call));
      // Warm both, with collection on, so first sights (statement shapes, series) are not counted.
      await setCollecting(true);
      for (let i = 0; i < 500; i += 1) await request();
      for (let i = 0; i < 100; i += 1) await ai();
      await flushSpans();
      const results = {
        request: await alternate(request),
        aiCall: await alternate(ai),
      };
      const out = process.env.OBS_BENCH_OUT;
      if (out !== undefined) writeFileSync(`${out}.whole.json`, `${JSON.stringify(results)}\n`);
      else console.log('obs bench, whole operations (CPU microseconds)', JSON.stringify(results));
      expect(results.request.offUs).toBeGreaterThan(0);
    }, 900_000);
  },
);
