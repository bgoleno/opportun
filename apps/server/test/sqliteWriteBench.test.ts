// An ordinary write path under the WAL checkpoint setting (https://github.com/bgoleno/opportun/issues/375):
// creating opportunities through the API, one request after another. It times each request and
// the event loop's longest stall, so a change to the checkpoint threshold is measured on the app's
// own writes, not only on the span flush. A benchmark, not a gate: it runs only with OBS_BENCH=1 and prints its figures.
//
//   OBS_BENCH=1 [OBS_BENCH_CKPT=<pages>] OBS_BENCH_OUT=<file> npx vitest run test/sqliteWriteBench.test.ts
import { writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { rawRun } from '../src/db/client';
import { useApi } from './api';

const boot = useApi();
const RUN = process.env.OBS_BENCH === '1';
const N = 1_500;

/** A title word from a number: the dedupe key drops digits, so titles differ by letters. */
const letters = (n: number): string =>
  n < 26 ? String.fromCharCode(97 + n) : letters(Math.floor(n / 26) - 1) + letters(n % 26);

const pct = (xs: number[], p: number) =>
  [...xs].sort((x, y) => x - y)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;

describe.runIf(RUN)('an ordinary write path under the checkpoint setting (#375)', () => {
  it('times opportunity creates', async () => {
    const { app, a } = await boot();
    const ckpt = process.env.OBS_BENCH_CKPT;
    if (ckpt !== undefined)
      await rawRun(app.db, sql.raw(`PRAGMA wal_autocheckpoint = ${Number(ckpt)}`));
    const create = (i: number) =>
      a.request({
        method: 'POST',
        url: '/api/v1/opportunities',
        payload: {
          companyName: `Company ${i % 50}`,
          title: `Role ${letters(i + 100)}`,
          descriptionMd: 'x'.repeat(2_000),
          postingUrl: `https://jobs.example.com/${i}`,
          sourceKind: 'manual',
        },
      });
    for (let i = 0; i < 50; i++) await create(N + i); // warm-up
    let last = performance.now();
    let worst = 0;
    let running = true;
    const beat = (): void => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
      if (running) setImmediate(beat);
    };
    setImmediate(beat);
    const each: number[] = [];
    const started = performance.now();
    for (let i = 0; i < N; i++) {
      const t = performance.now();
      const res = await create(i);
      each.push(performance.now() - t);
      expect(res.statusCode).toBe(201);
    }
    const totalMs = performance.now() - started;
    running = false;
    const report = {
      checkpointPages: ckpt ?? 'default',
      requests: N,
      totalMs: Math.round(totalMs),
      p50Ms: pct(each, 0.5),
      p99Ms: pct(each, 0.99),
      maxMs: Math.max(...each),
      worstStallMs: worst,
    };
    if (process.env.OBS_BENCH_OUT !== undefined) {
      writeFileSync(process.env.OBS_BENCH_OUT, `${JSON.stringify(report, null, 2)}\n`);
    }
  }, 300_000);
});
