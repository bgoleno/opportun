// The background WAL checkpointer on a slow disk (https://github.com/bgoleno/opportun/issues/383,
// criterion 3): the main thread's stalls while it writes, with the checkpointer off (the main
// connection checkpoints every 100 pages, inside a commit) and on (a worker checkpoints by WAL
// size or age, the main connection keeps a 10,000-page backstop), in three runs:
//
// - busy: 12,000 writes back to back, one per turn of the event loop, a burst the worker keeps
//   up with: the backstop is never reached, so no checkpoint runs on the main thread;
// - long: 50,000 writes, a burst past the backstop, which then fires on the main thread (at
//   least twice on the slow disk: tl wanted each firing's cost);
// - quiet: one small write every 1.5 s, past the worker's 60-second age bound, so the window
//   holds an age checkpoint and the restart that follows it.
//
// Asserted is what the design controls, not the single worst stall, one fsync's luck (tl on
// #393): the worker checkpointed inside each timed window; with it on, checkpoint time on the
// main thread is under a fifth of off's in total, and zero in the busy run; and p99. The worst
// stall and the slowest write, with what it was, are reported.
//
// What stays on the main thread is reported by kind. Each write is classed by the wal-index
// header read before and after it: a restart (the WAL starts again from its first frame, which
// a writer does with its own sync after a checkpoint copied everything) or a checkpoint run in
// the commit (with it off, or the backstop with it on). The slow disk is real, not simulated:
// `checkpoint_fullfsync = 1` makes a checkpoint's sync an F_FULLFSYNC on macOS, which flushes the
// drive's own cache. A 100-page checkpoint then takes 10 to 160 ms here instead of about 2 ms. On
// Linux the setting does nothing, so the two modes there show only the ordinary disk.
//
// A benchmark, not a gate: it runs only with OBS_BENCH=1 (several minutes), and writes its
// figures for the PR.
//
//   OBS_BENCH=1 [OBS_BENCH_SLOW=0] [OBS_BENCH_QUIET=0] OBS_BENCH_OUT=<file> \
//     npx vitest run test/sqliteCheckpointBench.test.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { rawRun, type SqliteHandle } from '../src/db/client';
import { startBackgroundCheckpointer, type CheckpointRecord } from '../src/db/checkpointer';
import { readWalIndex } from '../src/db/checkpointWorker';
import { sqliteOnly } from './db';
import { openTestDb } from './helpers';

const RUN = process.env.OBS_BENCH === '1' && sqliteOnly;
/** OBS_BENCH_SLOW=0 measures the ordinary disk instead (checkpoint_fullfsync off). */
const SLOW = process.env.OBS_BENCH_SLOW !== '0' ? 1 : 0;
const QUIET = process.env.OBS_BENCH_QUIET !== '0';
/** A burst the worker keeps up with: the backstop is never reached. */
const BUSY_WRITES = 12_000;
const BUSY_ROUNDS = 3;
/** A burst long enough to reach the backstop at least twice with the worker on. */
const LONG_WRITES = 50_000;
const LONG_ROUNDS = 2;
const QUIET_WRITES = 50;
const QUIET_GAP_MS = 1_500;
/** db/client.ts's backstop while the worker runs; OBS_BENCH_BACKSTOP compares another. */
const BACKSTOP_PAGES = Number(process.env.OBS_BENCH_BACKSTOP ?? '10000');

const quantile = (xs: number[], q: number) =>
  xs.length === 0
    ? 0
    : [...xs].sort((x, y) => x - y)[Math.min(xs.length - 1, Math.floor(xs.length * q))]!;
const r2 = (x: number) => Math.round(x * 100) / 100;
const summary = (xs: number[]) => ({
  count: xs.length,
  median: r2(quantile(xs, 0.5)),
  max: r2(xs.length === 0 ? 0 : Math.max(...xs)),
});

type Mode = 'off' | 'on';

async function round(mode: Mode, writes: number, gapMs: number, size: number) {
  const opened = await openTestDb();
  const h = opened.handle as SqliteHandle;
  const file = join(opened.dataDir, 'opportun.db');
  const pageSize = Number(h.sqlite.pragma('page_size', { simple: true }));
  h.sqlite.pragma(`checkpoint_fullfsync = ${SLOW}`);
  // "On" is what db/client.ts does when the flag is set, with the slow setting passed on.
  const checkpoints: CheckpointRecord[] = [];
  let checkpointer: ReturnType<typeof startBackgroundCheckpointer> | undefined;
  if (mode === 'on') {
    h.sqlite.pragma(`wal_autocheckpoint = ${BACKSTOP_PAGES}`);
    checkpointer = startBackgroundCheckpointer(file, {
      pragmas: [`checkpoint_fullfsync = ${SLOW}`],
      pageSize,
      onStopped: () => undefined,
      onCheckpoint: (c) => checkpoints.push(c),
    });
    await checkpointer.ready;
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
    let walPeak = 0;
    // The slowest write, and what it was: on a fresh database a log of 10,000 pages first has to
    // grow its file to 40 MB ('growth'), a cost SQLite pays once, as it reuses the file after.
    let slowest = {
      ms: 0,
      at: 0,
      kind: 'other' as 'growth' | 'restart' | 'checkpoint' | 'other',
    };
    const restarts: number[] = [];
    const inCommit: number[] = [];
    const value = 'x'.repeat(size);
    const started = performance.now();
    for (let i = 0; i < writes; i++) {
      const before = readWalIndex(`${file}-shm`, pageSize);
      const at = Date.now();
      const t = performance.now();
      await rawRun(h.db, sql`INSERT INTO bench_383 (v) VALUES (${value})`);
      const ms = performance.now() - t;
      const after = readWalIndex(`${file}-shm`, pageSize);
      each.push(ms);
      let kind: typeof slowest.kind = 'other';
      if (before !== undefined && after !== undefined) {
        if (after.mxFrame < before.mxFrame) {
          restarts.push(ms);
          kind = 'restart';
        } else if (after.nBackfill > before.nBackfill) {
          // Off, every copy is the commit's own. On, the worker copies beside the writes, and a
          // copy is the commit's only when the backstop's pages were reached before it.
          const waiting = before.mxFrame - before.nBackfill;
          if (mode === 'off' || waiting >= BACKSTOP_PAGES - 5) {
            inCommit.push(ms);
            kind = 'checkpoint';
          }
        }
        if (kind === 'other' && after.mxFrame > walPeak) kind = 'growth';
      }
      if (after !== undefined) walPeak = Math.max(walPeak, after.mxFrame);
      if (ms > slowest.ms) slowest = { ms: r2(ms), at, kind };
      // One write per turn of the loop, as one request is: the heartbeat then times each
      // stretch, where a chain of awaited writes would hold the loop for the whole run.
      if (gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
      else await new Promise((resolve) => setImmediate(resolve));
    }
    const totalMs = performance.now() - started;
    running = false;
    const index = readWalIndex(`${file}-shm`, pageSize);
    return {
      mode,
      worstStallMs: r2(worst),
      p50Ms: r2(quantile(each, 0.5)),
      p99Ms: r2(quantile(each, 0.99)),
      maxMs: r2(Math.max(...each)),
      totalMs: Math.round(totalMs),
      restarts: summary(restarts),
      checkpointsInCommit: summary(inCommit),
      checkpointsInCommitMs: inCommit.map(r2),
      mainCheckpointTotalMs: r2(inCommit.reduce((a, b) => a + b, 0)),
      workerCheckpoints: checkpoints.length,
      workerReasons: [...new Set(checkpoints.map((c) => c.reason))],
      workerCheckpointMs: summary(checkpoints.map((c) => c.ms)),
      walFramesAtEnd: index?.mxFrame,
      walFramesPeak: walPeak,
      slowestWrite: {
        ms: slowest.ms,
        kind: slowest.kind,
        // Whether a worker checkpoint was running while it did: the disk was then shared.
        duringWorkerCheckpoint: checkpoints.some(
          (c) => c.startedAt <= slowest.at + slowest.ms && slowest.at <= c.startedAt + c.ms,
        ),
      },
    };
  } finally {
    await checkpointer?.stop();
    await opened.close();
  }
}

type Round = Awaited<ReturnType<typeof round>>;

function report(rounds: Round[]) {
  const by = (mode: Mode) => {
    const rs = rounds.filter((r) => r.mode === mode);
    const med = (of: (r: Round) => number) => r2(quantile(rs.map(of), 0.5));
    return {
      worstStallMs: med((r) => r.worstStallMs),
      p50Ms: med((r) => r.p50Ms),
      p99Ms: med((r) => r.p99Ms),
      maxMs: med((r) => r.maxMs),
      totalMs: med((r) => r.totalMs),
      mainCheckpointTotalMs: med((r) => r.mainCheckpointTotalMs),
    };
  };
  return { off: by('off'), on: by('on'), rounds };
}

describe.runIf(RUN)('the background checkpointer on a slow disk (#383, reported in the PR)', () => {
  const out: Record<string, unknown> = { slowDisk: SLOW === 1 };
  const save = () => {
    if (process.env.OBS_BENCH_OUT !== undefined) {
      writeFileSync(process.env.OBS_BENCH_OUT, `${JSON.stringify(out, null, 2)}\n`);
    }
  };

  // What the design controls is asserted; the single worst stall, one fsync's luck, is reported.
  const busyAssertions = (rounds: Round[], backstopFires: boolean) => {
    const on = rounds.filter((r) => r.mode === 'on');
    const off = rounds.filter((r) => r.mode === 'off');
    for (const r of on) expect(r.workerCheckpoints).toBeGreaterThanOrEqual(2);
    const sum = (rs: Round[]) => rs.reduce((a, r) => a + r.mainCheckpointTotalMs, 0);
    expect(sum(on)).toBeLessThan(sum(off) / 5);
    if (!backstopFires) for (const r of on) expect(r.mainCheckpointTotalMs).toBe(0);
    const { off: offSummary, on: onSummary } = report(rounds);
    expect(onSummary.p99Ms).toBeLessThan(offSummary.p99Ms);
    // Only the slow disk is sure to reach it: on an ordinary one the worker keeps the WAL
    // restarting through the same burst, which is the better outcome.
    if (backstopFires && SLOW === 1) {
      for (const r of on) expect(r.checkpointsInCommit.count).toBeGreaterThanOrEqual(2);
    }
    return off;
  };

  it('busy: a burst the worker keeps up with, and the main thread runs no checkpoint', async () => {
    const rounds: Round[] = [];
    // Alternated, as the machine is shared.
    for (let i = 0; i < BUSY_ROUNDS; i++) {
      rounds.push(await round('off', BUSY_WRITES, 0, 3_500));
      rounds.push(await round('on', BUSY_WRITES, 0, 3_500));
    }
    out.busy = { writes: BUSY_WRITES, backstopPages: BACKSTOP_PAGES, ...report(rounds) };
    save();
    busyAssertions(rounds, false);
  }, 1_800_000);

  it('long: a burst past the backstop, which then fires on the main thread', async () => {
    const rounds: Round[] = [];
    for (let i = 0; i < LONG_ROUNDS; i++) {
      rounds.push(await round('off', LONG_WRITES, 0, 3_500));
      rounds.push(await round('on', LONG_WRITES, 0, 3_500));
    }
    out.long = { writes: LONG_WRITES, backstopPages: BACKSTOP_PAGES, ...report(rounds) };
    save();
    busyAssertions(rounds, true);
  }, 3_600_000);

  it.runIf(QUIET)(
    'quiet: an age checkpoint in the window, and what a quiet write pays',
    async () => {
      const rounds = [
        await round('off', QUIET_WRITES, QUIET_GAP_MS, 200),
        await round('on', QUIET_WRITES, QUIET_GAP_MS, 200),
      ];
      out.quiet = { writes: QUIET_WRITES, gapMs: QUIET_GAP_MS, ...report(rounds) };
      save();
      const on = rounds.find((r) => r.mode === 'on')!;
      expect(on.workerCheckpoints).toBeGreaterThanOrEqual(1);
      expect(on.workerReasons).toContain('age');
    },
    600_000,
  );
});
