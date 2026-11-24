// A job row left `running` with nothing running it, found without a restart (#974): the claim's answer
// was lost with its connection, or the write that ends the job failed for longer than it is tried
// again (#963). Postgres only: SQLite is not swept.
import { newId } from '@opportun/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PostgresConfig } from '../src/config';
import { connectDatabase, pgPoolConfig, type Db } from '../src/db/client';
import { onSlowTransaction } from '../src/db/gate';
import { jobs } from '../src/db/schema';
import { DemoResetGate, HOLD_LIMIT_MS } from '../src/lib/demoResetGate';
import { enqueue, setSchedule } from '../src/lib/jobQueue';
import { racePoint } from '../src/lib/racePoints';
import { registerJob, unregisterJob } from '../src/jobs/registry';
import { runDueJobs, startRunner, type Runner } from '../src/jobs/runner';
import { useApi } from './api';
import { testDialect } from './db';
import { captureLogs } from './helpers';
import { pauseAt } from './race';

const KIND = 'test.sweep';
const SWEEP_MS = 60;
const WORKER = 'sweep-worker';
const PUT_BACK = 'a job left running with nothing running it: queued again';
const MADE_DEAD = 'a job left running with nothing running it: dead';

const until = async (done: () => Promise<boolean> | boolean): Promise<void> => {
  for (let i = 0; i < 400; i += 1) {
    if (await done()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('never came');
};
/** Longer than several sweeps. */
const sweeps = () => new Promise((r) => setTimeout(r, SWEEP_MS * 5));

let logs = captureLogs();
const boot = useApi(() => ({ logStream: logs }));
beforeEach(() => {
  logs = captureLogs();
});
const open: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const end of open.splice(0).reverse()) await end().catch(() => undefined);
});

interface Job {
  maxAttempts?: number;
  /** What the handler does; the run's number, from 1. */
  body?: (run: number, db: Db) => Promise<void>;
  gate?: DemoResetGate;
  /** Of the writes that end a job. */
  limitMs?: number;
  workerId?: string | null;
}

/** A pool of its own for the runner, whose statements a test can watch. */
async function hooked(app: FastifyInstance) {
  const pool = new pg.Pool({ ...pgPoolConfig(app.config.db as PostgresConfig), max: 4 });
  open.push(() => pool.end());
  const { db } = await connectDatabase(app.config, { pool });
  const query = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
  /** Around each statement: `run` makes it. */
  const on: { statement?: (text: string, run: () => Promise<unknown>) => Promise<unknown> } = {};
  pool.query = (async (...args: unknown[]) => {
    const text = (args[0] as { text?: string }).text ?? String(args[0]);
    const run = () => query(...args);
    return on.statement === undefined ? run() : on.statement(text, run);
  }) as never;
  return { db, on };
}
const isClaim = (text: string) => text.includes("SET status = 'running'");
const endsJob = (text: string) => /^update "jobs" set /.test(text);

async function setUp(job: Job = {}) {
  const { app, a } = await boot({ logLevel: 'warn' });
  onSlowTransaction(() => undefined); // parked on purpose
  const by = new pg.Client({ connectionString: (app.config.db as PostgresConfig).url });
  by.on('error', () => undefined);
  await by.connect();
  open.push(() => by.end());
  const seen = { runs: 0, dead: 0, errors: [] as unknown[], ahead: 0 };
  registerJob({
    kind: KIND,
    payloadSchema: z.object({ text: z.string().optional() }),
    maxAttempts: job.maxAttempts ?? 3,
    transientPayloadKeys: ['text'],
    async run(db) {
      seen.runs += 1;
      const n = seen.runs;
      await racePoint('test.job');
      await job.body?.(n, db);
    },
    async onDead() {
      seen.dead += 1;
    },
  });
  open.push(async () => unregisterJob(KIND));
  const h = await hooked(app);
  const start = (over: { db?: Db } = {}): Runner => {
    const runner = startRunner(over.db ?? h.db, {
      intervalMs: 20,
      workers: 2,
      sweepMs: SWEEP_MS,
      ...(job.workerId === null ? {} : { workerId: job.workerId ?? WORKER }),
      random: () => 0,
      now: () => Date.now() + seen.ahead,
      rowRetry: { firstMs: 10, maxMs: 20, limitMs: job.limitMs ?? 150 },
      services: {
        log: app.log,
        ...(job.gate === undefined ? {} : { demoResetGate: job.gate }),
      },
      onError: (err) => seen.errors.push(err),
    });
    open.push(() => runner.stop());
    return runner;
  };
  const add = (opts: Parameters<typeof enqueue>[3] = {}) =>
    enqueue(app.db, KIND, { text: 'secret' }, opts);
  const rowOf = async (id: string) =>
    (await by.query<Record<string, unknown>>('SELECT * FROM jobs WHERE id = $1', [id])).rows[0]!;
  const statusOf = async (id: string) => (await rowOf(id)).status;
  /** The database answers a write of `status` to a job's row with `code`. */
  const refuse = async (status: string, code: string) => {
    await by.query(`CREATE OR REPLACE FUNCTION refuse_write() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'refused' USING ERRCODE = '${code}'; END $$`);
    await by.query('DROP TRIGGER IF EXISTS refuse_write ON jobs');
    await by.query(`CREATE TRIGGER refuse_write BEFORE UPDATE ON jobs FOR EACH ROW
      WHEN (NEW.status = '${status}') EXECUTE FUNCTION refuse_write()`);
  };
  const accept = () => by.query('DROP TRIGGER IF EXISTS refuse_write ON jobs');
  /** Of the test's own job: the app's schedules come due too when a test's clock goes ahead. */
  const said = (message: string) =>
    logs.lines.filter((l) => l.includes(message) && l.includes(KIND));
  return { app, a, by, seen, start, add, rowOf, statusOf, refuse, accept, said, ...h };
}

describe.runIf(testDialect === 'postgres')('the claim’s answer is lost (#974)', () => {
  /** The next claim is made, and its answer never comes. */
  const loseClaim = (on: Awaited<ReturnType<typeof hooked>>['on']) => {
    let lost = 0;
    on.statement = async (text, run) => {
      const result = await run();
      if (!isClaim(text) || lost > 0) return result;
      if ((result as { rows: unknown[] }).rows.length === 0) return result;
      lost += 1;
      throw new Error('Connection terminated unexpectedly');
    };
    return () => lost;
  };

  it('the job is queued again, its attempt counted, and runs', async () => {
    const t = await setUp();
    const lost = loseClaim(t.on);
    const id = await t.add({ dedupeKey: 'key' });
    t.start();
    await until(() => lost() === 1);
    await until(async () => (await t.statusOf(id)) === 'pending');
    const row = await t.rowOf(id);
    expect(row).toMatchObject({ attempts: 1, locked_by: null, locked_at: null });
    expect(Number(row.run_at)).toBeGreaterThan(Date.now() + 30_000);
    expect(t.seen.runs).toBe(0);
    t.seen.ahead = 60 * 60 * 1000;
    await until(async () => (await t.statusOf(id)) === 'done');
    expect([t.seen.runs, (await t.rowOf(id)).attempts]).toEqual([1, 2]);
    expect(t.said(PUT_BACK)).toHaveLength(1);
    // Its dedupe key is free.
    expect(await t.add({ dedupeKey: 'key', runAt: Date.now() + 1e9 })).not.toBe(id);
  });

  it('at its last attempt the job is dead, settled once, its transient payload dropped', async () => {
    const t = await setUp({ maxAttempts: 1 });
    const lost = loseClaim(t.on);
    const id = await t.add();
    t.start();
    await until(() => lost() === 1);
    await until(async () => (await t.statusOf(id)) === 'dead' && t.seen.dead > 0);
    await sweeps();
    expect([t.seen.runs, t.seen.dead, t.said(MADE_DEAD).length]).toEqual([0, 1, 1]);
    const row = await t.rowOf(id);
    expect(row).toMatchObject({ attempts: 1, locked_by: null });
    expect(row.payload).toBe('{}');
    expect(row.last_error).toMatch(/nothing/);
  });

  it('a claim the server makes late, after its connection ended, is found too', async () => {
    const t = await setUp();
    const runner = t.start();
    await sweeps();
    // What the server committed for this worker after the claim had failed here.
    const id = await t.add({ runAt: Date.now() + 1e9 });
    await t.by.query(
      `UPDATE jobs SET status = 'running', locked_by = $2, locked_at = $3, attempts = 1 WHERE id = $1`,
      [id, WORKER, Date.now()],
    );
    await until(async () => (await t.statusOf(id)) === 'pending');
    await runner.stop();
  });

  it('a schedule whose row is made dead goes on, on an idle server', async () => {
    const t = await setUp({ maxAttempts: 1 });
    await setSchedule(t.app.db, KIND, { cron: '0 3 * * *', enabled: true });
    const runner = t.start();
    const scheduled = async () =>
      (
        await t.by.query<{ id: string }>(
          "SELECT id FROM jobs WHERE kind = $1 AND status = 'pending'",
          [KIND],
        )
      ).rows.map((r) => r.id);
    await until(async () => (await scheduled()).length === 1);
    const [first] = await scheduled();
    await t.by.query(
      `UPDATE jobs SET status = 'running', locked_by = $2, locked_at = $3, attempts = 1 WHERE id = $1`,
      [first, WORKER, Date.now()],
    );
    await until(async () => (await t.statusOf(first!)) === 'dead');
    await until(async () => (await scheduled()).length === 1);
    expect(await scheduled()).not.toContain(first);
    expect(t.seen.runs).toBe(0);
    await runner.stop();
  });
});

describe.runIf(testDialect === 'postgres')('the end of a job was never written (#974)', () => {
  const failing = () => Promise.reject(new Error('failed'));

  it('done: the sweep writes it, and the job is not run again', async () => {
    const t = await setUp();
    await t.refuse('done', '57P03');
    const id = await t.add();
    t.start();
    await until(() => t.seen.errors.length > 0);
    expect(await t.rowOf(id)).toMatchObject({ status: 'running', attempts: 1 });
    await t.accept();
    await until(async () => (await t.statusOf(id)) === 'done');
    t.seen.ahead = 60 * 60 * 1000;
    await sweeps();
    expect(await t.rowOf(id)).toMatchObject({ status: 'done', attempts: 1 });
    expect((await t.rowOf(id)).payload).toBe('{}');
    expect([t.seen.runs, t.said(PUT_BACK).length]).toEqual([1, 0]);
  });

  it('done, of a schedule: its next occurrence is queued, on an idle server', async () => {
    const t = await setUp();
    await t.refuse('done', '57P03');
    await setSchedule(t.app.db, KIND, { cron: '0 3 * * *', enabled: true });
    t.start();
    const pending = async () =>
      (
        await t.by.query<{ id: string }>(
          "SELECT id FROM jobs WHERE kind = $1 AND status = 'pending'",
          [KIND],
        )
      ).rows.map((r) => r.id);
    await until(async () => (await pending()).length === 1);
    const [first] = await pending();
    await t.by.query('UPDATE jobs SET run_at = 0 WHERE id = $1', [first]);
    await until(() => t.seen.errors.length > 0);
    expect(await pending()).toEqual([]);
    await t.accept();
    await until(async () => (await t.statusOf(first!)) === 'done');
    await until(async () => (await pending()).length === 1);
    expect(t.seen.runs).toBe(1);
  });

  it('dead: the sweep writes it, and it is settled once', async () => {
    const t = await setUp({ maxAttempts: 1, body: failing });
    await t.refuse('dead', '57P03');
    const id = await t.add();
    t.start();
    await until(() => t.seen.errors.length > 0);
    expect([await t.statusOf(id), t.seen.dead]).toEqual(['running', 0]);
    await t.accept();
    await until(async () => (await t.statusOf(id)) === 'dead' && t.seen.dead > 0);
    await sweeps();
    expect(await t.rowOf(id)).toMatchObject({ last_error: 'Error: failed' });
    expect((await t.rowOf(id)).payload).toBe('{}');
    expect([t.seen.runs, t.seen.dead]).toEqual([1, 1]);
  });

  it('a retry: the sweep writes it as it was, and the job runs again', async () => {
    const t = await setUp({ body: (n) => (n === 1 ? failing() : Promise.resolve()) });
    await t.refuse('pending', '57P03');
    const id = await t.add();
    t.start();
    await until(() => t.seen.errors.length > 0);
    await t.accept();
    await until(async () => (await t.statusOf(id)) === 'pending');
    expect(await t.rowOf(id)).toMatchObject({ attempts: 1, last_error: 'Error: failed' });
    t.seen.ahead = 60 * 60 * 1000;
    await until(async () => (await t.statusOf(id)) === 'done');
    expect([t.seen.runs, t.said(PUT_BACK).length]).toEqual([2, 0]);
  });

  it('one that still fails waits for the next sweep', async () => {
    const t = await setUp();
    await t.refuse('done', '57P03');
    const id = await t.add();
    t.start();
    await until(() => t.seen.errors.length > 3); // the limit, and sweeps
    expect(await t.statusOf(id)).toBe('running');
    await t.accept();
    await until(async () => (await t.statusOf(id)) === 'done');
    expect(t.seen.runs).toBe(1);
  });

  it('a row changed since: what was kept is dropped', async () => {
    const t = await setUp();
    await t.refuse('done', '57P03');
    const id = await t.add();
    t.start();
    await until(() => t.seen.errors.length > 0);
    const claimedAt = (await t.rowOf(id)).locked_at;
    await t.by.query(
      "UPDATE jobs SET status = 'pending', run_at = $2, locked_by = NULL, locked_at = NULL WHERE id = $1",
      [id, Date.now() + 1e9],
    );
    const before = await t.rowOf(id);
    await t.accept();
    await sweeps();
    expect(await t.rowOf(id)).toEqual(before);
    // For good: the very claim on the row again, and it is nobody's outcome.
    await t.by.query(
      "UPDATE jobs SET status = 'running', locked_by = $2, locked_at = $3 WHERE id = $1",
      [id, WORKER, claimedAt],
    );
    await until(async () => (await t.statusOf(id)) === 'pending');
    expect((await t.rowOf(id)).attempts).toBe(1);
  });

  it('a row changed between the read and the kept write is left alone', async () => {
    const t = await setUp();
    await t.refuse('done', '57P03');
    const id = await t.add();
    t.start();
    await until(() => t.seen.errors.length > 0);
    const pause = pauseAt('jobs.sweep.found');
    await pause.reached;
    await t.accept();
    await t.by.query('UPDATE jobs SET attempts = attempts + 1 WHERE id = $1', [id]);
    const before = await t.rowOf(id);
    const next = pauseAt('jobs.sweep.found');
    pause.release();
    await next.reached;
    expect(await t.rowOf(id)).toEqual(before);
    next.release();
  });

  it('kept, then refused for what it says: dropped, and the next sweep queues the job again', async () => {
    const t = await setUp();
    await t.refuse('done', '57P03');
    const id = await t.add();
    t.start();
    await until(() => t.seen.errors.length > 0);
    await t.refuse('done', '22021');
    await until(async () => (await t.statusOf(id)) === 'pending');
    expect(await t.rowOf(id)).toMatchObject({ attempts: 1, locked_by: null });
    expect([t.seen.runs, t.said(PUT_BACK).length]).toEqual([1, 1]);
  });

  it('refused for what it says at once: queued again, and dead after its attempts', async () => {
    const t = await setUp({ maxAttempts: 2 });
    await t.refuse('done', '22021');
    const id = await t.add();
    t.start();
    await until(() => t.seen.errors.length > 0);
    await until(async () => (await t.statusOf(id)) === 'pending');
    t.seen.ahead = 60 * 60 * 1000;
    await until(async () => (await t.statusOf(id)) === 'dead');
    await until(() => t.seen.dead > 0);
    expect([t.seen.runs, t.seen.dead, t.said(PUT_BACK).length]).toEqual([2, 1, 1]);
    expect(await t.rowOf(id)).toMatchObject({ attempts: 2 });
    expect((await t.rowOf(id)).payload).toBe('{}');
  });

  it('the first write made, its answer lost, and the rest failing: nothing changes it', async () => {
    const t = await setUp();
    let writes = 0;
    t.on.statement = async (text, run) => {
      if (!endsJob(text)) return run();
      writes += 1;
      if (writes === 1) await run();
      throw new Error('Connection terminated unexpectedly');
    };
    const id = await t.add();
    t.start();
    await until(() => t.seen.errors.length > 0);
    const before = await t.rowOf(id);
    expect(before.status).toBe('done');
    delete t.on.statement;
    await sweeps();
    expect(await t.rowOf(id)).toEqual(before);
    expect([t.seen.runs, t.said(PUT_BACK).length]).toEqual([1, 0]);
  });

  it('a stop that ends the wait keeps nothing: the row is the next start’s', async () => {
    const t = await setUp({ limitMs: 60_000 });
    await t.refuse('done', '57P03');
    const id = await t.add();
    const runner = t.start();
    await until(() => t.said("a job's row could not be written").length > 0);
    await runner.stop();
    await t.accept();
    await sweeps();
    expect(await t.rowOf(id)).toMatchObject({ status: 'running', attempts: 1 });
  });

  describe('under the demo reset’s hold', () => {
    const ENDS_SOON = () => new DemoResetGate({ stopMarginMs: HOLD_LIMIT_MS - 400 });

    it('an instance job whose hold ended unwritten is queued again', async () => {
      const t = await setUp({ gate: ENDS_SOON(), limitMs: 60_000 });
      await t.refuse('done', '57P03');
      const id = await t.add();
      t.start();
      await until(() => t.said("a job's row could not be written").length > 0);
      await until(async () => (await t.statusOf(id)) === 'pending');
      expect(await t.rowOf(id)).toMatchObject({ attempts: 1, locked_by: null });
      expect([t.seen.runs, t.said(PUT_BACK).length]).toEqual([1, 1]);
    });

    it('nothing is kept, though its limit ran out first: it could be written past the hold', async () => {
      const t = await setUp({ gate: new DemoResetGate() });
      await t.refuse('done', '57P03');
      const id = await t.add();
      t.start();
      await until(() => t.seen.errors.length > 0);
      await t.accept();
      await until(async () => (await t.statusOf(id)) !== 'running');
      expect(await t.rowOf(id)).toMatchObject({ status: 'pending', attempts: 1 });
      expect(t.said(PUT_BACK)).toHaveLength(1);
    });

    it('one whose row the reset deleted: nothing is written', async () => {
      const t = await setUp({ gate: ENDS_SOON(), limitMs: 60_000, maxAttempts: 1 });
      await t.refuse('done', '57P03');
      const id = await t.add();
      t.start();
      await until(() => t.said("a job's row could not be written").length > 0);
      await t.by.query('DELETE FROM jobs WHERE id = $1', [id]);
      await t.accept();
      await new Promise((r) => setTimeout(r, 1000)); // past the hold's end
      expect(await t.rowOf(id)).toBeUndefined();
      expect([t.said(PUT_BACK).length, t.said(MADE_DEAD).length, t.seen.dead]).toEqual([0, 0, 0]);
    });
  });
});

describe.runIf(testDialect === 'postgres')('what is not left running (#974)', () => {
  it('a job that runs for several sweeps is left alone', async () => {
    const t = await setUp();
    const id = await t.add();
    const parked = pauseAt('test.job');
    t.start();
    await parked.reached;
    const before = await t.rowOf(id);
    await sweeps();
    expect(await t.rowOf(id)).toEqual(before);
    parked.release();
    await until(async () => (await t.statusOf(id)) === 'done');
    expect(t.seen.runs).toBe(1);
  });

  it('one whose end is still being tried is left alone', async () => {
    const t = await setUp({ limitMs: 60_000 });
    await t.refuse('done', '57P03');
    const id = await t.add();
    t.start();
    await until(() => t.said("a job's row could not be written").length > 0);
    const before = await t.rowOf(id);
    await sweeps();
    expect(await t.rowOf(id)).toEqual(before);
    await t.accept();
    await until(async () => (await t.statusOf(id)) === 'done');
    expect(t.seen.runs).toBe(1);
  });

  it('a claim made and not yet answered is left alone: the sweep waits for it', async () => {
    const t = await setUp();
    let answer!: () => void;
    const held = new Promise<void>((r) => (answer = r));
    let claimed = 0;
    t.on.statement = async (text, run) => {
      const result = await run();
      if (isClaim(text) && (result as { rows: unknown[] }).rows.length > 0) {
        claimed += 1;
        await held;
      }
      return result;
    };
    const id = await t.add();
    t.start();
    await until(() => claimed === 1);
    const before = await t.rowOf(id);
    expect(before.status).toBe('running');
    await sweeps();
    expect(await t.rowOf(id)).toEqual(before);
    answer();
    await until(async () => (await t.statusOf(id)) === 'done');
    expect([t.seen.runs, claimed]).toEqual([1, 1]);
  });

  const row = (over: Record<string, unknown>) => ({
    id: newId(),
    kind: KIND,
    payload: {},
    runAt: 0,
    attempts: 1,
    maxAttempts: 3,
    status: 'running' as const,
    lockedBy: WORKER,
    lockedAt: 5,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  });

  it('another worker’s row is left alone', async () => {
    const t = await setUp();
    t.start();
    await sweeps(); // past the startup's own recovery
    const mine = row({});
    const theirs = row({ lockedBy: 'another-worker' });
    await t.app.db
      .insert(jobs)
      .values([mine, theirs] as never)
      .run();
    await until(async () => (await t.statusOf(mine.id)) === 'pending');
    expect(await t.rowOf(theirs.id)).toMatchObject({
      status: 'running',
      locked_by: 'another-worker',
    });
  });

  it.each([
    ['its status', "status = 'done'"],
    ['its worker', "locked_by = 'another-worker'"],
    ['when it was claimed', 'locked_at = locked_at + 1'],
    ['its attempt', 'attempts = attempts + 1'],
  ])(
    'a row changed between the read and the write, by %s alone, is left alone',
    async (_by, change) => {
      const t = await setUp();
      t.start();
      await sweeps(); // past the startup's own recovery
      const left = row({});
      const first = pauseAt('jobs.sweep.found');
      await t.app.db
        .insert(jobs)
        .values(left as never)
        .run();
      await first.reached;
      await t.by.query(`UPDATE jobs SET ${change} WHERE id = $1`, [left.id]);
      const before = await t.rowOf(left.id);
      const next = pauseAt('jobs.sweep.found');
      next.reached.catch(() => undefined); // not for the first two
      first.release();
      // Still this worker's by the last two: the next sweep finds it, as it is now.
      if (change.startsWith('status') || change.startsWith('locked_by')) await sweeps();
      else await next.reached;
      expect(await t.rowOf(left.id)).toEqual(before);
      expect(t.said(PUT_BACK)).toEqual([]);
      next.release();
    },
  );

  it('at its last attempt, changed between the read and the write: not dead, not settled', async () => {
    const t = await setUp();
    t.start();
    await sweeps();
    const left = row({ attempts: 3 });
    const pause = pauseAt('jobs.sweep.found');
    await t.app.db
      .insert(jobs)
      .values(left as never)
      .run();
    await pause.reached;
    await t.by.query("UPDATE jobs SET status = 'done' WHERE id = $1", [left.id]);
    pause.release();
    await sweeps();
    expect(await t.statusOf(left.id)).toBe('done');
    expect([t.said(MADE_DEAD).length, t.seen.dead]).toEqual([0, 0]);
  });

  it('no job is claimed while a sweep reads: it would be in neither its set nor its gate', async () => {
    let letGo!: () => void;
    const held = new Promise<void>((r) => (letGo = r));
    const t = await setUp({ body: () => held });
    t.start();
    await sweeps();
    const pause = pauseAt('jobs.sweep.reading');
    await pause.reached;
    const id = await t.add();
    await sweeps();
    expect(await t.statusOf(id)).toBe('pending');
    pause.release();
    await until(() => t.seen.runs === 1);
    await sweeps();
    expect(await t.rowOf(id)).toMatchObject({ status: 'running', attempts: 1 });
    letGo();
    await until(async () => (await t.statusOf(id)) === 'done');
    expect([t.seen.runs, t.said(PUT_BACK).length]).toEqual([1, 0]);
  });

  it('a job of runDueJobs in the same process is left alone', async () => {
    const t = await setUp({ workerId: null });
    const id = await t.add();
    const parked = pauseAt('test.job');
    const draining = runDueJobs(t.app.db, {});
    await parked.reached;
    const before = await t.rowOf(id);
    // The startup's recovery takes every running row (one process): after it, then.
    await t.by.query("UPDATE jobs SET status = 'done' WHERE id = $1", [id]);
    t.start();
    await sweeps();
    await t.by.query("UPDATE jobs SET status = 'running' WHERE id = $1", [id]);
    await sweeps();
    expect(await t.rowOf(id)).toMatchObject({ status: 'running', locked_by: before.locked_by });
    parked.release();
    await draining;
    expect(t.seen.runs).toBe(1);
  });

  it('a sweep that fails says so, and the next one goes on', async () => {
    const t = await setUp();
    t.start();
    await sweeps();
    let failed = 0;
    t.on.statement = async (text, run) => {
      if (/^select .*"locked_at".* from "jobs"/.test(text) && failed === 0) {
        failed += 1;
        throw new Error('Connection terminated unexpectedly');
      }
      return run();
    };
    const left = row({});
    await t.app.db
      .insert(jobs)
      .values(left as never)
      .run();
    await until(async () => (await t.statusOf(left.id)) === 'pending');
    expect([failed, t.seen.errors.length]).toEqual([1, 1]);
  });

  it('a stop waits for a sweep under way, and none follows', async () => {
    const t = await setUp();
    const runner = t.start();
    await sweeps();
    const left = row({});
    const pause = pauseAt('jobs.sweep.found');
    await t.app.db
      .insert(jobs)
      .values(left as never)
      .run();
    await pause.reached;
    let stopped = false;
    const stopping = runner.stop().then(() => (stopped = true));
    await sweeps();
    expect(stopped).toBe(false);
    pause.release();
    await stopping;
    const later = row({ id: newId() });
    await t.app.db
      .insert(jobs)
      .values(later as never)
      .run();
    await sweeps();
    expect(await t.statusOf(later.id)).toBe('running');
  });
});

describe.runIf(testDialect === 'sqlite')('SQLite (#974)', () => {
  it('is not swept: as before, the next start recovers the row', async () => {
    const { app } = await boot({ logLevel: 'warn' });
    const runner = startRunner(app.db, { intervalMs: 20, sweepMs: SWEEP_MS, workerId: WORKER });
    await sweeps();
    const id = newId();
    await app.db
      .insert(jobs)
      .values({
        id,
        kind: KIND,
        payload: {},
        runAt: 0,
        attempts: 1,
        maxAttempts: 3,
        status: 'running',
        lockedBy: WORKER,
        lockedAt: 5,
        createdAt: 1,
        updatedAt: 1,
      } as never)
      .run();
    await sweeps();
    const row = await app.db.select().from(jobs).where(eq(jobs.id, id)).get();
    expect(row?.status).toBe('running');
    await runner.stop();
  });
});
