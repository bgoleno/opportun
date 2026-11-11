// The span flush yields to the event loop (https://github.com/bgoleno/opportun/issues/375): a
// flush of 2,000 buffered spans, the buffer's cap, never blocks the event loop for 10 ms or more.
// On SQLite a transaction is synchronous, so the flush is written in chunks with a yield between
// them; this measures the longest stretch with a setImmediate heartbeat, the gap between two
// turns of the loop, not the flush's whole time. A benchmark, not a gate: timings vary by machine,
// so it runs only with OBS_BENCH=1, and prints its figures for the PR.
//
//   OBS_BENCH=1 OBS_BENCH_OUT=<file> npx vitest run test/obsFlushBench.test.ts
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client';
import { flushBatch, type Pending, SPAN_BUFFER_MAX, SPAN_FLUSH_CHUNK } from '../src/obs/spanStore';
import { useApi } from './api';

const boot = useApi();
const RUN = process.env.OBS_BENCH === '1';
const T = 1_790_000_000_000;

const hex = (n: number, width: number) => n.toString(16).padStart(width, '0');

/** 2,000 kept spans: 100 traces of a workflow root and 19 calls, as a busy run makes. */
function batch(userId: string, salt: number): Pending[] {
  const out: Pending[] = [];
  for (let t = 0; t < SPAN_BUFFER_MAX / 20; t++) {
    const traceId = hex(salt * 1_000 + t + 1, 32);
    const root = hex(salt * 100_000 + t * 20 + 1, 16);
    for (let s = 0; s < 20; s++) {
      const spanId = s === 0 ? root : hex(salt * 100_000 + t * 20 + 1 + s, 16);
      const attributes =
        s === 0
          ? { 'gen_ai.operation.name': 'invoke_workflow', 'gen_ai.agent.name': 'discovery_run' }
          : {
              'gen_ai.operation.name': 'chat',
              'opportun.ai.task': 'discovery.rank',
              'gen_ai.request.model': 'claude-haiku-5-5',
              'opportun.ai.provider': 'anthropic',
              'gen_ai.usage.input_tokens': 1_200,
              'gen_ai.usage.output_tokens': 80,
              'opportun.gen_ai.usage.cost': 0.0012,
              'user.id': userId,
            };
      out.push({
        span: {
          traceId,
          spanId,
          parentSpanId: s === 0 ? null : root,
          name: s === 0 ? 'invoke_workflow discovery_run' : 'chat claude-haiku-5-5',
          kind: s === 0 ? 'internal' : 'client',
          startMs: T + t * 1_000 + s * 10,
          durationMs: 8,
          status: 'ok',
          attributes,
        },
        userId,
        traceUserId: userId,
        origin: s === 0 ? 'job discovery.run' : undefined,
        root: s === 0,
      });
    }
  }
  return out;
}

/**
 * The gaps between turns of the event loop while `work` runs, in ms: the longest, and every one
 * over 5 ms. After `work` resolves, one more turn lets a beat that `work` held back record its gap.
 */
async function stalls(
  work: () => Promise<void>,
): Promise<{ worstMs: number; over5Ms: number[]; totalMs: number }> {
  let last = performance.now();
  let worst = 0;
  const over5: number[] = [];
  let running = true;
  const beat = (): void => {
    const now = performance.now();
    const gap = now - last;
    worst = Math.max(worst, gap);
    if (gap > 5) over5.push(Math.round(gap * 10) / 10);
    last = now;
    if (running) setImmediate(beat);
  };
  setImmediate(beat);
  const started = performance.now();
  await work();
  const totalMs = performance.now() - started;
  await new Promise((resolve) => setImmediate(resolve));
  running = false;
  return { worstMs: worst, over5Ms: over5, totalMs };
}

async function measure(db: Db, userId: string, salt: number, chunkSize: number) {
  const spans = batch(userId, salt);
  const { worstMs, over5Ms, totalMs } = await stalls(() => flushBatch(db, spans, T, { chunkSize }));
  return {
    chunkSize,
    spans: spans.length,
    worstStallMs: worstMs,
    over5Ms,
    totalMs,
    perChunkMs: totalMs / Math.ceil(spans.length / chunkSize),
  };
}

describe.runIf(RUN)('the span flush yields to the event loop (#375, reported in the PR)', () => {
  it('a 2,000-span flush never stalls the loop for 10 ms or more', async () => {
    const { app, a } = await boot();
    // A warm-up flush first, so the statements' first sight is not counted.
    await flushBatch(app.db, batch(a.userId, 9), T, {});
    // The control: the same heartbeat over an idle wait as long as a flush, for this machine's
    // own noise (other work, GC) without a flush.
    const idle = await stalls(() => new Promise((resolve) => setTimeout(resolve, 200)));
    const rounds = [];
    for (let i = 0; i < 5; i++) {
      // Alternated, as the machine is shared: the chunked flush, then the whole batch at once.
      rounds.push(await measure(app.db, a.userId, i * 2 + 1, SPAN_FLUSH_CHUNK));
      rounds.push(await measure(app.db, a.userId, i * 2 + 2, SPAN_BUFFER_MAX));
    }
    const chunked = rounds.filter((r) => r.chunkSize === SPAN_FLUSH_CHUNK);
    const whole = rounds.filter((r) => r.chunkSize === SPAN_BUFFER_MAX);
    const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
    const report = {
      chunkSize: SPAN_FLUSH_CHUNK,
      chunked: {
        worstStallMs: Math.max(...chunked.map((r) => r.worstStallMs)),
        medianWorstStallMs: median(chunked.map((r) => r.worstStallMs)),
        medianPerChunkMs: median(chunked.map((r) => r.perChunkMs)),
        medianTotalMs: median(chunked.map((r) => r.totalMs)),
      },
      oneTransaction: {
        medianWorstStallMs: median(whole.map((r) => r.worstStallMs)),
        medianTotalMs: median(whole.map((r) => r.totalMs)),
      },
      idleControl: { worstStallMs: idle.worstMs, over5Ms: idle.over5Ms },
      rounds,
    };
    if (process.env.OBS_BENCH_OUT !== undefined) {
      writeFileSync(process.env.OBS_BENCH_OUT, `${JSON.stringify(report, null, 2)}\n`);
    }
    expect(report.chunked.worstStallMs).toBeLessThan(10);
  }, 120_000);
});
