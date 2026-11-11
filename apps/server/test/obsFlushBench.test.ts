// The span flush yields to the event loop (https://github.com/bgoleno/opportun/issues/375): a
// flush of 2,000 buffered spans, the buffer's cap, never works on the event loop for 10 ms or more
// at a stretch. On SQLite a transaction is synchronous, so the flush is written in chunks with a
// yield between them; a setImmediate heartbeat measures each gap between two turns of the loop,
// in wall time and in the process's CPU time, and the assertion is on the CPU time (see below).
// A benchmark, not a gate: timings vary by machine, so it runs only with OBS_BENCH=1, and prints
// its figures for the PR. Each round also lists the garbage collections over 2 ms, which ruled GC
// out as a cause; the long stalls were SQLite's WAL checkpoints, hence the server's threshold of
// 100 pages (db/client.ts).
//
//   OBS_BENCH=1 [OBS_BENCH_CKPT=<pages>] OBS_BENCH_OUT=<file> npx vitest run test/obsFlushBench.test.ts
import { writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { rawRun, type Db } from '../src/db/client';
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
 * The gaps between turns of the event loop while `work` runs: each one's wall time, and the
 * process's CPU time inside it. After `work` resolves, one more turn lets a beat that `work` held
 * back record its gap. It also lists the garbage collections over 2 ms.
 */
async function stalls(work: () => Promise<void>): Promise<{
  wallMs: number[];
  cpuMs: number[];
  totalMs: number;
  gcOver2Ms: string[];
}> {
  const gcs: string[] = [];
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      const kind = (e as unknown as { detail?: { kind?: number } }).detail?.kind;
      if (e.duration > 2) gcs.push(`${kind}:${e.duration.toFixed(1)}`);
    }
  });
  obs.observe({ entryTypes: ['gc'] });
  const cpuNow = () => {
    const u = process.cpuUsage();
    return (u.user + u.system) / 1_000;
  };
  const wallMs: number[] = [];
  const cpuMs: number[] = [];
  let last = performance.now();
  let lastCpu = cpuNow();
  let running = true;
  const beat = (): void => {
    const now = performance.now();
    const cpu = cpuNow();
    wallMs.push(now - last);
    cpuMs.push(cpu - lastCpu);
    last = now;
    lastCpu = cpu;
    if (running) setImmediate(beat);
  };
  setImmediate(beat);
  const started = performance.now();
  await work();
  const totalMs = performance.now() - started;
  await new Promise((resolve) => setImmediate(resolve));
  running = false;
  await new Promise((resolve) => setTimeout(resolve, 0));
  obs.disconnect();
  return { wallMs, cpuMs, totalMs, gcOver2Ms: gcs };
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const quantile = (xs: number[], q: number) =>
  [...xs].sort((x, y) => x - y)[Math.min(xs.length - 1, Math.floor(xs.length * q))]!;

async function measure(db: Db, userId: string, salt: number, chunkSize: number) {
  const spans = batch(userId, salt);
  const { wallMs, cpuMs, totalMs, gcOver2Ms } = await stalls(() =>
    flushBatch(db, spans, T, { chunkSize }),
  );
  const over5 = wallMs.flatMap((w, i) => (w > 5 ? [[round1(w), round1(cpuMs.at(i) ?? 0)]] : []));
  return {
    chunkSize,
    spans: spans.length,
    worstStallMs: Math.max(...wallMs),
    worstCpuInGapMs: Math.max(...cpuMs),
    wallMs,
    // [wall, cpu] of each gap over 5 ms.
    over5,
    gcOver2Ms,
    totalMs,
    perChunkMs: totalMs / Math.ceil(spans.length / chunkSize),
  };
}

describe.runIf(RUN)('the span flush yields to the event loop (#375, reported in the PR)', () => {
  it('a 2,000-span flush never works on the event loop for 10 ms or more at a stretch', async () => {
    const { app, a } = await boot();
    // The server's own checkpoint threshold (db/client.ts), unless OBS_BENCH_CKPT sets another
    // to compare (0 turns automatic checkpoints off).
    const ckpt = process.env.OBS_BENCH_CKPT;
    if (ckpt !== undefined) {
      await rawRun(app.db, sql.raw(`PRAGMA wal_autocheckpoint = ${Number(ckpt)}`));
    }
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
    const median = (xs: number[]) => quantile(xs, 0.5);
    const chunkedGaps = chunked.flatMap((r) => r.wallMs);
    const report = {
      chunkSize: SPAN_FLUSH_CHUNK,
      checkpointPages: ckpt ?? 'server default',
      chunked: {
        worstCpuInGapMs: Math.max(...chunked.map((r) => r.worstCpuInGapMs)),
        worstStallMs: Math.max(...chunked.map((r) => r.worstStallMs)),
        medianWorstStallMs: median(chunked.map((r) => r.worstStallMs)),
        gapMedianMs: median(chunkedGaps),
        gapP95Ms: quantile(chunkedGaps, 0.95),
        medianPerChunkMs: median(chunked.map((r) => r.perChunkMs)),
        medianTotalMs: median(chunked.map((r) => r.totalMs)),
      },
      oneTransaction: {
        medianWorstStallMs: median(whole.map((r) => r.worstStallMs)),
        medianTotalMs: median(whole.map((r) => r.totalMs)),
      },
      idleControl: {
        worstStallMs: Math.max(...idle.wallMs),
        worstCpuInGapMs: Math.max(...idle.cpuMs),
      },
      // Every gap of every round would be thousands of numbers: the summary above stands for them.
      rounds: rounds.map((r) => ({ ...r, wallMs: undefined })),
    };
    if (process.env.OBS_BENCH_OUT !== undefined) {
      writeFileSync(process.env.OBS_BENCH_OUT, `${JSON.stringify(report, null, 2)}\n`);
    }
    // The bound is on the work the flush does on the event loop: the process's CPU time inside
    // any one gap stays under 10 ms. Wall time is reported beside it but not asserted, as it also
    // counts waiting for the disk or for other processes, which a loaded machine or a shared CI
    // runner adds without the flush doing more (tl on #375). The CPU figure counts every thread of
    // this process, the GC's and SQLite's included, so it can only overstate the flush's own work.
    expect(report.chunked.worstCpuInGapMs).toBeLessThan(10);
  }, 120_000);
});
