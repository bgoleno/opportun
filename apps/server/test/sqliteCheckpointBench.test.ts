// The background WAL checkpointer on a slow disk (https://github.com/bgoleno/opportun/issues/383,
// criterion 3): the main thread's worst stall while it writes, with the checkpointer off (the
// main connection checkpoints every 100 pages, inside a commit) and on (a worker checkpoints).
//
// The slow disk is real, not simulated: `checkpoint_fullfsync = 1` makes a checkpoint's fsync an
// F_FULLFSYNC on macOS, which flushes the drive's own cache. A 100-page checkpoint then takes
// 10 to 160 ms here instead of about 2 ms, as a fsync does on an SD card or a network volume.
// On Linux the setting does nothing, so the two modes there show only the ordinary disk.
//
// A benchmark, not a gate: timings vary by machine, so it runs only with OBS_BENCH=1, and writes
// its figures for the PR.
//
//   OBS_BENCH=1 [OBS_BENCH_SLOW=0] OBS_BENCH_OUT=<file> npx vitest run test/sqliteCheckpointBench.test.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { rawRun, type SqliteHandle } from '../src/db/client';
import { startBackgroundCheckpointer } from '../src/db/checkpointer';
import { sqliteOnly } from './db';
import { openTestDb } from './helpers';

const RUN = process.env.OBS_BENCH === '1' && sqliteOnly;
const WRITES = 1_500;
const ROUNDS = 4;
/** OBS_BENCH_SLOW=0 measures the ordinary disk instead (checkpoint_fullfsync off), for comparison. */
const SLOW = process.env.OBS_BENCH_SLOW !== '0' ? 1 : 0;

const quantile = (xs: number[], q: number) =>
  [...xs].sort((x, y) => x - y)[Math.min(xs.length - 1, Math.floor(xs.length * q))]!;
const median = (xs: number[]) => quantile(xs, 0.5);
const r2 = (x: number) => Math.round(x * 100) / 100;

async function round(mode: 'off' | 'on') {
  const opened = await openTestDb();
  const h = opened.handle as SqliteHandle;
  h.sqlite.pragma(`checkpoint_fullfsync = ${SLOW}`);
  // "On" is what db/client.ts does when the flag is set, with the slow setting passed on.
  let checkpointer: ReturnType<typeof startBackgroundCheckpointer> | undefined;
  if (mode === 'on') {
    h.sqlite.pragma('wal_autocheckpoint = 0');
    checkpointer = startBackgroundCheckpointer(join(opened.dataDir, 'opportun.db'), {
      pragmas: [`checkpoint_fullfsync = ${SLOW}`],
      onStopped: () => undefined,
    });
  }
  try {
    await rawRun(h.db, sql`CREATE TABLE bench_383 (v TEXT)`);
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
    for (let i = 0; i < WRITES; i++) {
      const t = performance.now();
      await rawRun(h.db, sql`INSERT INTO bench_383 (v) VALUES (${'x'.repeat(3_500)})`);
      each.push(performance.now() - t);
      // One write per turn of the loop, as one request is: the heartbeat then times each
      // stretch, where a chain of awaited writes would hold the loop for the whole run.
      await new Promise((resolve) => setImmediate(resolve));
    }
    const totalMs = performance.now() - started;
    running = false;
    return {
      mode,
      worstStallMs: r2(worst),
      p50Ms: r2(quantile(each, 0.5)),
      p99Ms: r2(quantile(each, 0.99)),
      maxMs: r2(Math.max(...each)),
      totalMs: Math.round(totalMs),
    };
  } finally {
    await checkpointer?.stop();
    await opened.close();
  }
}

describe.runIf(RUN)('the background checkpointer on a slow disk (#383, reported in the PR)', () => {
  it('takes the checkpoint stalls off the main thread', async () => {
    const rounds: Awaited<ReturnType<typeof round>>[] = [];
    // Alternated, as the machine is shared.
    for (let i = 0; i < ROUNDS; i++) {
      rounds.push(await round('off'));
      rounds.push(await round('on'));
    }
    const summary = (mode: 'off' | 'on') => {
      const rs = rounds.filter((r) => r.mode === mode);
      const pick = (of: (r: (typeof rs)[number]) => number) => ({
        median: r2(median(rs.map(of))),
        min: Math.min(...rs.map(of)),
        max: Math.max(...rs.map(of)),
      });
      return {
        worstStallMs: pick((r) => r.worstStallMs),
        p50Ms: pick((r) => r.p50Ms),
        p99Ms: pick((r) => r.p99Ms),
        maxMs: pick((r) => r.maxMs),
        totalMs: pick((r) => r.totalMs),
      };
    };
    const report = {
      writes: WRITES,
      slowDisk: SLOW === 1,
      off: summary('off'),
      on: summary('on'),
      rounds,
    };
    if (process.env.OBS_BENCH_OUT !== undefined) {
      writeFileSync(process.env.OBS_BENCH_OUT, `${JSON.stringify(report, null, 2)}\n`);
    }
    // With the checkpoints in the worker, the main thread's worst stall is well under the one it
    // has when a commit runs them, on the same slow disk.
    if (SLOW === 1) {
      expect(report.on.worstStallMs.median).toBeLessThan(report.off.worstStallMs.median / 2);
    }
  }, 600_000);
});
