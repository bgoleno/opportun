// Durable SQLite job queue (NFR-OPS4, design section 8). Jobs are claimed atomically with
// UPDATE ... RETURNING, retried with capped exponential backoff, and parked as `dead` once
// they run out of attempts. One runner per process: on start, jobs a crashed process left
// `running` go back to `pending`. The scheduler turns settings rows schedule:<kind> (a cron
// expression) into the next pending job for that kind.
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { USER_CONTEXT_KEY } from '@opportun/ai';
import { ROOT_CONTEXT } from '@opentelemetry/api';
import { and, eq, gte, sql, type SQL } from 'drizzle-orm';
import { isStatementError, isUniqueViolation, runCount, type Db } from '../db/client';
import { claimNextJob, type ClaimedJob } from '../db/dialect';
import { SHARED_DEMO_IDS } from '../lib/demoAccounts';
import { runWithHoldStop } from '../lib/demoResetGate';
import { HttpError } from '../lib/errors';
import { jobs, SCHEMA_DIALECT } from '../db/schema';
import { racePoint } from '../lib/racePoints';
import {
  dropPendingScheduled,
  insertJob,
  nextOccurrence,
  readSchedules,
  scheduleDedupeKey,
} from '../lib/jobQueue';
import { keyedFetch } from '../lib/safeFetch';
import { truncateText } from '../lib/safeText';
import { contextFromTraceparent, isCollecting, obs } from '../obs';
import { OTHER } from '../obs/catalog';
import { errorType } from '../obs/outbound';
import { RANK_BATCH_CLEANUP_KIND, RANK_WAITING_KIND } from '../lib/jobKinds';
import { CLASSIFY_WAITING_KIND } from '../lib/mailClassifyQueue';
import { finishInterruptedRuns } from './interruptedRuns';
import { getJobHandler, type JobContext, type JobHandler, type JobServices } from './registry';
import { jobWorkersSetting } from '../config';

/**
 * The services a job gets: a job that belongs to a user fetches under that user's rate key
 * (#617), so the per-host bucket shares a vendor host between users rather than one user's jobs
 * holding every slot ahead of another's.
 */
function servicesFor(services: Partial<JobServices>, userId: string | null): Partial<JobServices> {
  if (userId === null || services.sourceFetch === undefined) return services;
  return { ...services, sourceFetch: keyedFetch(services.sourceFetch, userId) };
}

const BASE_DELAY_MS = 30_000;
const MAX_JITTER_MS = 10_000;
const MAX_DELAY_MS = 3_600_000;
const MAX_ERROR_LENGTH = 2000;
const DEFAULT_INTERVAL_MS = 1000;
/** How long a write that puts a job's row right is tried again, and how often (writeRow). */
export interface RowRetry {
  /** Before the second try; then doubled, up to maxMs. */
  firstMs: number;
  maxMs: number;
  /** In all. An error that is not an outage must not hold a worker for ever. */
  limitMs: number;
}
const ROW_RETRY: RowRetry = { firstMs: 1000, maxMs: 30_000, limitMs: 300_000 };
/** How often a runner looks for rows left running (startRunner's sweep). */
const SWEEP_MS = 60_000;
/** Postgres only: SQLite's claim has no answer to lose, and its rows wait for the next start. */
const SWEPT = SCHEMA_DIALECT === 'postgres';
/** Upper bound on jobs one drain processes, so a runaway enqueue loop cannot spin forever. */
const MAX_DRAIN = 10_000;
/** Jobs run in parallel; OPPORTUN_JOB_WORKERS overrides, 1 restores serial behaviour. */
const DEFAULT_WORKERS = 4;
/**
 * Kinds whose own concurrency is capped below the worker pool, whatever the worker count.
 * `gmail.sync`/`gmail.sync_all`/`backup` are capped at 1 because parallelism buys nothing and
 * costs correctness: a second Gmail sync for the same mailbox duplicates work, and two backups
 * would write the same file. `company.ats_detect` (issue #260) is a different reason: each run
 * makes several live calls out to whichever ATS vendor it's probing (Greenhouse, Lever, Ashby
 * or Workday), and it went from firing 7 times ever to firing on most enrich attempts that find
 * a careers page -- capped at 2 so a cluster of new companies can't hit one vendor from every
 * worker at once. `discovery.rank_waiting` (https://github.com/bgoleno/opportun/issues/260) holds
 * its worker through a user's whole backlog and there is one per user, so a few users with backlogs
 * would otherwise take the pool: capped at 2, which leaves workers free at the default pool of 4.
 * With OPPORTUN_JOB_WORKERS at 2 or fewer, drains can still fill the pool. Everything absent is
 * limited only by the pool, which is the point: a user's import no longer waits behind a long sync.
 */
export const DEFAULT_KIND_LIMITS: Readonly<Record<string, number>> = {
  'gmail.sync': 1,
  'gmail.sync_all': 1,
  backup: 1,
  'company.ats_detect': 2,
  // The board probe after a company suggestion (#221) runs that same detection and then lists the
  // board, and a weekly run queues up to 15 of them at once: the same cap, for the same reason.
  'company.board_probe': 2,
  // The nightly network probe (#296): one at a time on the instance, so one user's probes run one
  // after another and a vendor's 429 cancels the rest before any of them starts.
  'company.network_probe': 1,
  [RANK_WAITING_KIND]: 2,
  // A user's drain of waiting mail holds its worker, as rank_waiting's does (#1050): one, so that
  // beside two of those the default pool of 4 has a worker left.
  [CLASSIFY_WAITING_KIND]: 1,
  // A batch's provider cleanup (#686, tl): one at a time on the instance, so a provider that hangs
  // ties up one worker, not all of them.
  [RANK_BATCH_CLEANUP_KIND]: 1,
};

function envWorkers(): number {
  return jobWorkersSetting() ?? DEFAULT_WORKERS;
}

export type JobRow = typeof jobs.$inferSelect;
export type JobStatus = JobRow['status'];

/** min(2^attempts * 30s + jitter(0-10s), 1h). */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const jitter = Math.floor(Math.min(Math.max(random(), 0), 1) * MAX_JITTER_MS);
  return Math.min(2 ** attempts * BASE_DELAY_MS + jitter, MAX_DELAY_MS);
}

export interface RunOptions {
  /** Clock (tests pin it to drive backoff deterministically). */
  now?: () => number;
  /** Jitter source in [0, 1). */
  random?: () => number;
  workerId?: string;
  services?: Partial<JobServices>;
  /** Whether the runner is shutting down; passed to handlers as ctx.stopping. */
  stopping?: () => boolean;
  /** Failures outside a handler (e.g. the database went away). */
  onError?: (err: unknown) => void;
  /**
   * startRunner's: a write that puts a job's row right is tried again (writeRow) until this says to
   * give up. Without it, one that fails throws at once.
   */
  giveUp?: AbortSignal;
  /** ROW_RETRY unless a test sets another. */
  rowRetry?: RowRetry;
  /** startRunner's: a write given up at its limit, for the sweep to make. */
  keep?: ((job: ClaimedJob, kept: KeptWrite) => void) | undefined;
}

/**
 * What a claimed job came to, not written yet, and what follows it (afterDead). In memory only, and it
 * closes over the whole job, its payload as claimed included: at most one for each worker before claims
 * stop, until a sweep makes it or drops it (sec on https://github.com/bgoleno/opportun/pull/992).
 */
interface KeptWrite {
  /** Resolves with how many rows it wrote. */
  write: (own?: SQL) => Promise<number>;
  after?: (() => Promise<void>) | undefined;
}

const newWorkerId = (): string => `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
/** runNextJob's and runDueJobs'. A runner has one of its own: what it sweeps is its own alone. */
const defaultWorkerId = newWorkerId();

/** The row is still running for this very claim. */
const isClaim = (
  workerId: string,
  claimed: { lockedAt: number; attempts: number },
): SQL | undefined =>
  and(
    eq(jobs.status, 'running'),
    eq(jobs.lockedBy, workerId),
    eq(jobs.lockedAt, claimed.lockedAt),
    eq(jobs.attempts, claimed.attempts),
  );

/**
 * Claims the oldest due pending job for this worker: one UPDATE ... RETURNING whose subquery
 * picks the row (db/dialect.ts claimNextJob; FOR UPDATE SKIP LOCKED on Postgres), so no two
 * workers claim the same job.
 */
async function claim(
  db: Db,
  workerId: string,
  now: number,
  excludeKinds: readonly string[] = [],
): Promise<ClaimedJob | undefined> {
  await racePoint('jobs.claim');
  return claimNextJob(db, workerId, now, undefined, excludeKinds);
}

/**
 * The payload with the handler's transient fields removed, or undefined when there is nothing
 * to remove. See JobHandler.transientPayloadKeys: this is what keeps a finished job row from
 * becoming the lasting copy of a message body the app deliberately does not store.
 */
function withoutTransient(
  handler: JobHandler<unknown> | undefined,
  payload: unknown,
): unknown | undefined {
  const keys = handler?.transientPayloadKeys;
  if (keys === undefined || keys.length === 0) return undefined;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const out: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  let changed = false;
  for (const key of keys) {
    if (!(key in out)) continue;
    // eslint-disable-next-line security/detect-object-injection -- key comes from the handler
    delete out[key];
    changed = true;
  }
  return changed ? out : undefined;
}

async function finish(
  db: Db,
  id: string,
  status: 'done' | 'dead',
  now: number,
  error?: string,
  payload?: unknown,
  own?: SQL,
): Promise<number> {
  return await runCount(
    db
      .update(jobs)
      .set({
        status,
        lockedBy: null,
        lockedAt: null,
        updatedAt: now,
        // A done job carries no error: one left from an earlier attempt is not this outcome's, and
        // Settings > Jobs would show it as if it were (qa's regression pass, #784).
        ...(error === undefined
          ? status === 'done'
            ? { lastError: null }
            : {}
          : { lastError: truncateText(error, MAX_ERROR_LENGTH) }),
        ...(payload === undefined ? {} : { payload }),
      })
      .where(and(eq(jobs.id, id), own)),
  );
}

/**
 * Writes what a claimed job came to, and tries again when that fails, until opts.giveUp or the limit:
 * then it throws. At the limit it is kept first (opts.keep), so that the sweep writes it and nothing
 * runs twice (#974); otherwise the row is the next start's, or the sweep's, to recover. A write refused for what it says is not
 * tried again: it would be refused each time, and hold the worker. In a restart of Postgres the write that
 * ends the job the restart caught fails too, and the row stayed `running`: never run again, its dedupe
 * key held (tl on https://github.com/bgoleno/opportun/issues/963). The worker waits here meanwhile.
 *
 * A write whose answer was lost may have been made, and the row since claimed again, by this worker
 * too. So from the second try `write` gets `own`, which only this claim's run matches, and a row that
 * does not match it any more is left alone: it has been written.
 */
async function writeRow(
  job: ClaimedJob,
  opts: RunOptions,
  write: (own?: SQL) => Promise<number>,
  after?: () => Promise<void>,
): Promise<void> {
  const { firstMs, maxMs, limitMs } = opts.rowRetry ?? ROW_RETRY;
  const { giveUp } = opts;
  // Not the clock a test pins.
  const until = performance.now() + limitMs;
  let own: SQL | undefined;
  for (let delay = firstMs; ; delay = Math.min(delay * 2, maxMs)) {
    try {
      await write(own);
      return;
    } catch (err) {
      if (giveUp === undefined || giveUp.aborted || isStatementError(err)) throw err;
      if (own === undefined) {
        opts.services?.log?.warn(
          { 'opportun.job.id': job.id, 'opportun.job.kind': job.kind, err },
          "a job's row could not be written; trying again",
        );
      }
      own = isClaim(opts.workerId ?? defaultWorkerId, job);
      if (performance.now() + delay > until) {
        opts.keep?.(job, { write, after });
        throw err;
      }
      const waited = await sleep(delay, true, { signal: giveUp, ref: false }).catch(() => false);
      if (!waited) throw err;
    }
  }
}

/**
 * Hands a job just marked dead to its handler (JobHandler.onDead, #869). Its payload is read as it
 * was stored; one that does not validate has nothing to hand over. A throw is only logged: the job
 * is dead either way. For a row the sweep ended it runs outside the demo reset's hold (#974), so an
 * onDead that writes for a shared demo account would need its own.
 */
async function afterDead(
  db: Db,
  job: { id: string; kind: string; payload: unknown; userId: string | null },
  log: JobServices['log'] | undefined,
): Promise<void> {
  const handler = getJobHandler(job.kind);
  if (handler?.onDead === undefined) return;
  const parsed = handler.payloadSchema.safeParse(job.payload);
  if (!parsed.success) return;
  try {
    await handler.onDead(db, parsed.data, { userId: job.userId });
  } catch (err) {
    log?.error(
      { 'opportun.job.id': job.id, 'opportun.job.kind': job.kind, err },
      'a dead job was not settled by its handler',
    );
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** How a run ended, for the job metric and span (#343). */
interface JobOutcome {
  /** discarded: a shared demo account's job whose account the nightly reset replaced (#618). */
  outcome: 'done' | 'retry' | 'dead' | 'discarded';
  /** A class or code (14.8): `no_handler`, `invalid_payload`, or the thrown error's. */
  errorType?: string;
}

/**
 * The job boundary (design.md 14.2, 14.6; #343): around the whole run, so a job that dies before
 * its handler runs is counted too. The span is `job {kind}`: a CONSUMER child of the trace in
 * jobs.trace_context when the row carries a valid one, else a new INTERNAL trace. A failed run
 * writes one `error` event in that trace. With collection off, one check and the plain run.
 */
async function processJob(db: Db, job: ClaimedJob, opts: RunOptions): Promise<void> {
  if (!isCollecting()) {
    await runJob(db, job, opts);
    return;
  }
  // An unregistered kind is not on the catalog's list: _OTHER, so a stray row adds no series.
  const kind = getJobHandler(job.kind) === undefined ? OTHER : job.kind;
  // A job is a trace of its own unless it continues the one stored with it (14.6): it starts
  // from the root, never from whatever span or user the runner's caller had active. Its user goes
  // on that parent (not on an outer context), so the AI router finds it in the job's span; an
  // instance job has none, and the router starts one trace per user it calls for.
  const root =
    job.userId === null ? ROOT_CONTEXT : ROOT_CONTEXT.setValue(USER_CONTEXT_KEY, job.userId);
  const continued = contextFromTraceparent(job.traceContext, root);
  const started = performance.now();
  await obs.span(
    'job',
    { 'opportun.job.kind': kind },
    async (span) => {
      const { outcome, errorType: failure } = await runJob(db, job, opts);
      const attributes = {
        'opportun.job.kind': kind,
        'opportun.job.outcome': outcome,
        ...(failure === undefined ? {} : { 'error.type': failure }),
      };
      span.set({ 'opportun.job.outcome': outcome });
      obs.record('opportun.job.duration', (performance.now() - started) / 1000, attributes);
      // #345: the job.finished event (design 14.9), in the job's own trace.
      obs.event(
        'job.finished',
        {
          'opportun.job.kind': kind,
          'opportun.job.outcome': outcome,
          'opportun.job.attempt': job.attempts,
        },
        job.userId === null ? {} : { userId: job.userId },
      );
      if (failure === undefined) return;
      span.fail(failure);
      obs.event(
        'error',
        { 'error.type': failure, 'opportun.job.kind': kind },
        job.userId === null ? {} : { userId: job.userId },
      );
    },
    continued === undefined ? { parent: root } : { parent: continued, kind: 'consumer' },
  );
}

async function runJob(db: Db, job: ClaimedJob, opts: RunOptions): Promise<JobOutcome> {
  const now = opts.now ?? Date.now;
  const log = opts.services?.log;
  const handler = getJobHandler(job.kind);
  if (handler === undefined) {
    const reason = `no handler registered for kind ${job.kind}`;
    // #345: a fixed message, the kind in its catalogued key (design 14.9).
    log?.error(
      { 'opportun.job.id': job.id, 'opportun.job.kind': job.kind },
      'no handler registered for this job kind',
    );
    await writeRow(job, opts, (own) => finish(db, job.id, 'dead', now(), reason, undefined, own));
    return { outcome: 'dead', errorType: 'no_handler' };
  }
  // Decoded by the claim; undefined when the stored payload is not JSON.
  const parsed = handler.payloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    // A stored payload that no longer validates will never succeed: no retries.
    log?.error(
      { 'opportun.job.id': job.id, 'opportun.job.kind': job.kind, err: parsed.error },
      'invalid stored payload; job marked dead',
    );
    // Stripped like any finished job's (#175): a payload that does not validate may still
    // carry a body.
    const kept = withoutTransient(handler, job.payload);
    await writeRow(job, opts, (own) =>
      finish(db, job.id, 'dead', now(), `invalid payload: ${parsed.error.message}`, kept, own),
    );
    return { outcome: 'dead', errorType: 'invalid_payload' };
  }
  let holdExpired = false;
  // The hold's stop signal (#684), once the job holds the gate: set below.
  const held: { stop?: AbortSignal } = {};
  const ctx: JobContext = {
    jobId: job.id,
    userId: job.userId,
    attempt: job.attempts,
    maxAttempts: job.maxAttempts,
    services: servicesFor(opts.services ?? {}, job.userId),
    // Also true once its hold on the demo reset's gate is about to end (its stop signal, the
    // margin before the bound: tl on #704), or has: a job that loops stops before its AI calls
    // all fail at once and it writes their failures.
    stopping: () => holdExpired || held.stop?.aborted === true || (opts.stopping?.() ?? false),
    async setResult(value) {
      await db
        .update(jobs)
        .set({ result: value, updatedAt: Date.now() })
        .where(eq(jobs.id, job.id))
        .run();
    },
  };
  // Computed before the run, from the payload as stored: a handler is free to mutate what it
  // was given, and what must not outlive the job is what the row holds.
  const transient = withoutTransient(handler, job.payload);
  // On a demo server a job holds the reset's gate for its whole run (#618), so it finishes before
  // the nightly reset starts, or waits for it: a shared demo account's job, and an instance job,
  // whose per-user work (the prompt refinements, say) can reach those accounts (tl on #618). Not
  // the reset itself, nor a job of any other account. Once it holds it, its row must still be
  // there: the reset deletes the shared accounts' jobs with them, so a job claimed before the reset
  // is discarded without running, and writes nothing into the account reseeded under the same id.
  // A hold has a bound (lib/demoResetGate.ts): past it the job is told to stop (ctx.stopping).
  const gate = opts.services?.demoResetGate;
  const gated =
    gate !== undefined &&
    handler.takesDemoResetGateItself !== true &&
    (job.userId === null || SHARED_DEMO_IDS.has(job.userId));
  const hold = gated
    ? await gate.shared({
        onExpire: () => {
          holdExpired = true;
          log?.warn(
            { 'opportun.job.id': job.id, 'opportun.job.kind': job.kind },
            'job held the demo reset gate to its limit; told to stop',
          );
        },
      })
    : undefined;
  if (hold !== undefined) held.stop = hold.signal;
  // Past its hold a job's row is the reset's, which may have reseeded the account under the same id:
  // a write still waiting then would land in it.
  const ending: RunOptions =
    hold === undefined || opts.giveUp === undefined
      ? opts
      : // Nothing is kept either: once the hold has ended, what it came to is not written at all.
        { ...opts, giveUp: AbortSignal.any([opts.giveUp, hold.signal]), keep: undefined };
  try {
    if (hold !== undefined) {
      let still: { id: string } | undefined;
      try {
        still = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, job.id)).get();
      } catch (err) {
        // It never ran. Not due at once: the worker claims again straight away.
        const runAt = now() + BASE_DELAY_MS;
        await writeRow(job, ending, (own) => unclaim(db, job, { runAt, own }));
        throw err;
      }
      if (still === undefined) {
        log?.warn(
          { 'opportun.job.id': job.id, 'opportun.job.kind': job.kind },
          'job discarded: the demo reset replaced its account',
        );
        return { outcome: 'discarded' };
      }
    }
    const run = () => runHandler(db, job, ending, handler, parsed.data, ctx, transient);
    // Its AI calls end on the hold's stop signal, before the bound (#684).
    return await (hold === undefined ? run() : runWithHoldStop(hold.signal, run));
  } finally {
    hold?.release();
  }
}

/** The handler's run, and the row's end: done, retried later, or dead. */
async function runHandler(
  db: Db,
  job: ClaimedJob,
  opts: RunOptions,
  handler: JobHandler<unknown>,
  payload: unknown,
  ctx: JobContext,
  transient: unknown,
): Promise<JobOutcome> {
  const now = opts.now ?? Date.now;
  const log = opts.services?.log;
  try {
    await handler.run(db, payload, ctx);
  } catch (err) {
    const at = now();
    // #345: catalogued keys (design 14.9); the error reduces to its type and frames in the log.
    const fields = {
      'opportun.job.id': job.id,
      'opportun.job.kind': job.kind,
      'opportun.job.attempt': job.attempts,
      'opportun.job.max_attempts': job.maxAttempts,
      err,
    };
    // Once, and not in the write: what throws here would throw on each of its tries.
    const text = errorText(err);
    if (job.attempts >= job.maxAttempts) {
      log?.error(fields, 'job exhausted its retries; marked dead');
      const settle = () => afterDead(db, job, log);
      await writeRow(
        job,
        opts,
        (own) => finish(db, job.id, 'dead', at, text, transient, own),
        settle,
      );
      await settle();
      return { outcome: 'dead', errorType: errorType(err) };
    } else {
      log?.warn(fields, 'job failed; will retry');
      const runAt = at + backoffMs(job.attempts, opts.random);
      await writeRow(job, opts, (own) =>
        runCount(
          db
            .update(jobs)
            .set({
              status: 'pending',
              runAt,
              lockedBy: null,
              lockedAt: null,
              lastError: truncateText(text, MAX_ERROR_LENGTH),
              updatedAt: at,
            })
            .where(and(eq(jobs.id, job.id), own)),
        ),
      );
      return { outcome: 'retry', errorType: errorType(err) };
    }
  }
  await writeRow(job, opts, (own) => finish(db, job.id, 'done', now(), undefined, transient, own));
  return { outcome: 'done' };
}

/** Claims and runs one due job. Resolves false when nothing is due. */
export async function runNextJob(db: Db, opts: RunOptions = {}): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const job = await claim(db, opts.workerId ?? defaultWorkerId, now());
  if (job === undefined) return false;
  await processJob(db, job, opts);
  await safeMaterialize(db, now(), opts);
  return true;
}

/** Runs due jobs until none is left; resolves with how many ran. */
export async function runDueJobs(db: Db, opts: RunOptions = {}): Promise<number> {
  let ran = 0;
  while (ran < MAX_DRAIN && (await runNextJob(db, opts))) ran += 1;
  return ran;
}

/**
 * Single-process deployment: anything still `running` when a runner starts was orphaned by
 * a crash or kill, so it goes back to `pending` (its attempt stays counted).
 */
export async function recoverStaleJobs(
  db: Db,
  opts: { now?: number; random?: () => number; log?: JobServices['log'] } = {},
): Promise<number> {
  const now = opts.now ?? Date.now();
  const orphans = await db
    .select({
      id: jobs.id,
      kind: jobs.kind,
      payload: jobs.payload,
      userId: jobs.userId,
      attempts: jobs.attempts,
      maxAttempts: jobs.maxAttempts,
    })
    .from(jobs)
    .where(eq(jobs.status, 'running'))
    .all();
  for (const job of orphans) {
    // #588: a job that ended the process (out of memory mid-import, say) was put back on every
    // start whatever its attempts, so it ran again each time: a crash loop. At its last attempt it
    // is dead, as a job that threw there would be (its transient payload fields dropped the same).
    if (job.attempts >= job.maxAttempts) {
      await finish(
        db,
        job.id,
        'dead',
        now,
        `orphaned: the process ended while its last attempt (${job.attempts} of ${job.maxAttempts}) ran`,
        withoutTransient(getJobHandler(job.kind), job.payload),
      );
      opts.log?.error(
        { 'opportun.job.id': job.id, 'opportun.job.kind': job.kind },
        'a job left running at its last attempt when the process ended: dead',
      );
      await afterDead(db, job, opts.log);
      continue;
    }
    // With attempts left it waits out the backoff a failure would have given it (#588), rather
    // than run at once on a start that may follow the very crash it caused.
    await db
      .update(jobs)
      .set({
        status: 'pending',
        lockedBy: null,
        lockedAt: null,
        runAt: now + backoffMs(job.attempts, opts.random),
        updatedAt: now,
      })
      .where(and(eq(jobs.id, job.id), eq(jobs.status, 'running')))
      .run();
  }
  // A pending row already at its limit is never claimed (claimJobSql), so it would sit for ever,
  // and a schedule's row would stop its schedule (qa on #720). Main's recovery before #588 left
  // such rows: an orphan put back with its attempts unchanged. Dead, saying why; a schedule then
  // queues its next occurrence (safeMaterialize, after this).
  const spent = await db
    .select({ id: jobs.id, kind: jobs.kind, payload: jobs.payload, userId: jobs.userId })
    .from(jobs)
    .where(and(eq(jobs.status, 'pending'), gte(jobs.attempts, jobs.maxAttempts)))
    .all();
  for (const job of spent) {
    await finish(
      db,
      job.id,
      'dead',
      now,
      'pending at its attempt limit: it will not be claimed again',
      withoutTransient(getJobHandler(job.kind), job.payload),
    );
    opts.log?.error(
      { 'opportun.job.id': job.id, 'opportun.job.kind': job.kind },
      'a pending job at its attempt limit: dead',
    );
    await afterDead(db, job, opts.log);
  }
  return orphans.length + spent.length;
}

/** Puts back a claimed job that never ran: pending, unlocked, and its attempt not counted. */
async function unclaim(
  db: Db,
  job: ClaimedJob,
  to: { runAt?: number; own?: SQL | undefined } = {},
): Promise<number> {
  return await runCount(
    db
      .update(jobs)
      .set({
        status: 'pending',
        lockedBy: null,
        lockedAt: null,
        attempts: job.attempts - 1,
        ...(to.runAt === undefined ? {} : { runAt: to.runAt }),
        updatedAt: Date.now(),
      })
      .where(and(eq(jobs.id, job.id), to.own)),
  );
}

/**
 * One row a runner left running (startRunner's sweep), as recoverStaleJobs treats a dead process's:
 * queued again with the backoff of a failure, its attempt counted, or dead at its last attempt. The
 * texts are fixed and no payload but the row's own is written, so neither is refused for what it says.
 * Null when the row is no longer that claim's; else what is said and done once the gate is let go.
 */
async function endLeftRow(
  db: Db,
  row: {
    id: string;
    kind: string;
    payload: unknown;
    userId: string | null;
    attempts: number;
    maxAttempts: number;
  },
  own: SQL | undefined,
  opts: RunOptions,
): Promise<{ dead: boolean; after: () => Promise<void> } | null> {
  const now = (opts.now ?? Date.now)();
  const log = opts.services?.log;
  const fields = { 'opportun.job.id': row.id, 'opportun.job.kind': row.kind };
  if (row.attempts >= row.maxAttempts) {
    const reason = `left running: nothing ran its last attempt (${row.attempts} of ${row.maxAttempts}) to an end that was recorded`;
    const kept = withoutTransient(getJobHandler(row.kind), row.payload);
    if ((await finish(db, row.id, 'dead', now, reason, kept, own)) === 0) return null;
    return {
      dead: true,
      after: async () => {
        log?.error(fields, 'a job left running with nothing running it: dead');
        await afterDead(db, row, log);
      },
    };
  }
  const written = await runCount(
    db
      .update(jobs)
      .set({
        status: 'pending',
        lockedBy: null,
        lockedAt: null,
        runAt: now + backoffMs(row.attempts, opts.random),
        lastError: 'left running: nothing was running it, so it was queued again',
        updatedAt: now,
      })
      .where(and(eq(jobs.id, row.id), own)),
  );
  if (written === 0) return null;
  return {
    dead: false,
    after: async () =>
      log?.warn(fields, 'a job left running with nothing running it: queued again'),
  };
}

export interface Runner {
  /**
   * Stops polling and starting jobs, and resolves once every running job has finished. A job
   * whose claim was already in flight goes back to pending instead of starting.
   */
  stop(): Promise<void>;
}

/** Polls for due jobs every intervalMs (default 1s), after materializing schedules. */
export function startRunner(
  db: Db,
  opts: RunOptions & {
    intervalMs?: number;
    /** Jobs run at once (default OPPORTUN_JOB_WORKERS, else 4). */
    workers?: number;
    /** Per-kind ceilings; a kind absent from the map is limited only by the pool. */
    kindLimits?: Readonly<Record<string, number>>;
    /** SWEEP_MS unless a test sets another. */
    sweepMs?: number;
  } = {},
): Runner {
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const workers = Math.max(1, opts.workers ?? envWorkers());
  const limits = opts.kindLimits ?? DEFAULT_KIND_LIMITS;
  const clock = opts.now ?? Date.now;
  const workerId = opts.workerId ?? newWorkerId();
  let stopped = false;
  /** Ends a wait to write a job's row, which stop() does not wait out: the next start recovers it. */
  const giveUp = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  /** How many jobs of each kind are running right now, for the per-kind ceilings. */
  const activeByKind = new Map<string, number>();
  const atCap = (): string[] =>
    [...activeByKind.entries()]
      // eslint-disable-next-line security/detect-object-injection -- job kinds are server constants, and a missing one falls back to no cap
      .filter(([kind, n]) => n >= (limits[kind] ?? Number.POSITIVE_INFINITY))
      .map(([kind]) => kind);

  /**
   * The claims in hand: each from inside the claim gate until its worker lets it go, so a job whose end
   * is being tried again is in hand too. By the whole claim: a row put back by a write whose answer was
   * lost can be claimed again while the first worker still waits.
   */
  const inHand = new Set<string>();
  const claimKey = (c: { id: string; lockedAt: number | null; attempts: number }): string =>
    `${c.id}:${c.lockedAt}:${c.attempts}`;
  /** Ends that could not be written in time, by their claim. Kept before it leaves the hand. */
  const unwritten = new Map<string, KeptWrite>();

  /**
   * Claims run one at a time even though the handlers do not. The counts above are read and
   * written around an await, so two workers could otherwise both pass a ceiling of one; and
   * SQLite takes one writer at a time regardless, so nothing is lost by queueing here.
   */
  let claimGate: Promise<void> = Promise.resolve();
  const claimOne = (): Promise<ClaimedJob | undefined> => {
    const claimed = claimGate.then(async () => {
      if (stopped) return undefined;
      const job = await claim(db, workerId, clock(), atCap());
      if (job !== undefined) {
        activeByKind.set(job.kind, (activeByKind.get(job.kind) ?? 0) + 1);
        inHand.add(claimKey(job));
      }
      return job;
    });
    claimGate = claimed.then(
      () => undefined,
      () => undefined,
    );
    return claimed;
  };

  const release = (kind: string): void => {
    const left = (activeByKind.get(kind) ?? 1) - 1;
    if (left <= 0) activeByKind.delete(kind);
    else activeByKind.set(kind, left);
  };

  /** Claims and runs until nothing is due for this worker; never rejects. */
  const workerLoop = async (): Promise<void> => {
    while (!stopped) {
      let job: ClaimedJob | undefined;
      try {
        job = await claimOne();
      } catch (err) {
        opts.onError?.(err);
        return;
      }
      if (job === undefined) return;
      try {
        // stop() came while the claim was in flight. Running it now would hold up the shutdown for
        // the whole job, since stop() waits for it. If the write fails, the next start recovers it.
        if (stopped) {
          await unclaim(db, job);
          return;
        }
        await processJob(db, job, {
          ...opts,
          workerId,
          stopping: () => stopped,
          giveUp: giveUp.signal,
          // Only where a sweep takes it.
          keep: SWEPT ? (claimed, kept) => unwritten.set(claimKey(claimed), kept) : undefined,
        });
        await safeMaterialize(db, clock(), opts);
      } catch (err) {
        opts.onError?.(err);
      } finally {
        inHand.delete(claimKey(job));
        release(job.kind);
      }
    }
  };

  /**
   * Ends the rows this runner left running: their claim's answer was lost with its connection, or the
   * write of their end failed past its limit (#974). Not on a flag, as a claim can be made after its
   * connection ended here. It holds the claim gate, so no claim is in flight, and only reads and writes
   * single rows there; what follows comes after. A row of another worker's is not read, and each write
   * is for the claim that was read. Never rejects.
   */
  const sweep = async (): Promise<void> => {
    const after: (() => Promise<void>)[] = [];
    let ended = false;
    const swept = claimGate.then(async () => {
      if (stopped) return;
      // Before the read: a job that ends meanwhile is either in this set or fails its write's guard.
      const held = new Set(inHand);
      await racePoint('jobs.sweep.reading');
      const rows = await db
        .select({
          id: jobs.id,
          kind: jobs.kind,
          payload: jobs.payload,
          userId: jobs.userId,
          attempts: jobs.attempts,
          maxAttempts: jobs.maxAttempts,
          lockedAt: jobs.lockedAt,
        })
        .from(jobs)
        .where(and(eq(jobs.status, 'running'), eq(jobs.lockedBy, workerId)))
        .all();
      const running = new Set(rows.map(claimKey));
      for (const key of unwritten.keys()) {
        if (running.has(key)) continue;
        unwritten.delete(key);
        // Written after all, its answer lost: the worker that gave it up queued no next occurrence.
        ended = true;
      }
      const left = rows.filter((row) => !held.has(claimKey(row)));
      if (left.length === 0) return;
      await racePoint('jobs.sweep.found');
      for (const { lockedAt, ...row } of left) {
        if (lockedAt === null) continue;
        const key = claimKey({ ...row, lockedAt });
        const own = isClaim(workerId, { lockedAt, attempts: row.attempts });
        const kept = unwritten.get(key);
        try {
          if (kept === undefined) {
            const done = await endLeftRow(db, row, own, opts);
            if (done === null) continue;
            ended ||= done.dead;
            after.push(done.after);
            continue;
          }
          const written = await kept.write(own);
          unwritten.delete(key);
          if (written === 0) continue;
          ended = true;
          if (kept.after !== undefined) after.push(kept.after);
        } catch (err) {
          // Refused for what it says, as it would be again: the next sweep ends the row without it. Any
          // other error is tried again by then, and the rows after this one are not held up by it.
          if (isStatementError(err)) unwritten.delete(key);
          opts.onError?.(err);
        }
      }
    });
    claimGate = swept.catch(() => undefined);
    try {
      await swept;
    } catch (err) {
      opts.onError?.(err);
    }
    for (const then of after) {
      try {
        await then();
      } catch (err) {
        opts.onError?.(err);
      }
    }
    // An idle server materializes after no job: the schedule of a row ended here would wait.
    if (ended) await safeMaterialize(db, clock(), opts);
  };

  let sweepTimer: NodeJS.Timeout | undefined;
  let sweeping: Promise<void> = Promise.resolve();
  /** One after another, from the startup's recovery on. */
  const scheduleSweep = (): void => {
    if (stopped || !SWEPT) return;
    sweepTimer = setTimeout(() => {
      sweeping = sweep().finally(scheduleSweep);
    }, opts.sweepMs ?? SWEEP_MS);
    sweepTimer.unref();
  };

  const schedule = (delay: number) => {
    timer = setTimeout(tick, delay);
    timer.unref();
  };
  /** The worker loops running now, counted as each starts: at most `workers`. None rejects. */
  const loops = new Set<Promise<void>>();
  /**
   * Starts a loop for each free worker, and looks again on every interval whatever is running. A
   * worker with nothing to claim ends, and a job can run for hours (a drain, a long sync), so waiting
   * for the pool to go idle would leave a job queued meanwhile behind that one, with workers free
   * (https://github.com/bgoleno/opportun/issues/263).
   */
  function tick(): void {
    if (stopped) return;
    for (let i = loops.size; i < workers; i++) {
      const loop: Promise<void> = workerLoop().finally(() => loops.delete(loop));
      loops.add(loop);
    }
    schedule(interval);
  }
  // Startup work starts now (stop() waits for it): orphaned jobs go back to pending, the runs they
  // left unfinished are ended as interrupted (#323), then schedules materialize; the first poll
  // follows immediately, so no run begins before the interrupted ones are ended.
  const startup = (async () => {
    try {
      await recoverStaleJobs(db, {
        now: clock(),
        ...(opts.random === undefined ? {} : { random: opts.random }),
        ...(opts.services?.log === undefined ? {} : { log: opts.services.log }),
      });
      await finishInterruptedRuns(db);
      await safeMaterialize(db, clock(), opts);
    } catch (err) {
      opts.onError?.(err);
    }
  })().finally(() => {
    if (!stopped) schedule(0);
    scheduleSweep();
  });

  return {
    async stop() {
      stopped = true;
      giveUp.abort();
      if (timer !== undefined) clearTimeout(timer);
      if (sweepTimer !== undefined) clearTimeout(sweepTimer);
      // Nothing starts a loop from here: the timer is gone, and startup schedules none once stopped.
      await startup;
      await Promise.all(loops);
      await sweeping;
    },
  };
}

/** Age of the oldest due pending job (0 when the queue is caught up). */
export async function queueLagMs(db: Db, now: number = Date.now()): Promise<number> {
  const row = await db
    .select({ oldest: sql<number | null>`min(${jobs.runAt})` })
    .from(jobs)
    .where(and(eq(jobs.status, 'pending'), sql`${jobs.runAt} <= ${now}`))
    .get();
  const oldest = row?.oldest ?? null;
  return oldest === null ? 0 : Math.max(0, now - oldest);
}

/**
 * pending -> dead on demand (issue #66), stripping the handler's transient payload fields the
 * same way a normal finish does, so a job cancelled before it ever ran does not keep carrying
 * something like a message body forever in a row nothing will revisit. Undefined when the job
 * is not pending right now: already finished, or a worker claimed it between the caller's
 * decision and this call. Atomic on status so that race costs the caller a retry, never a
 * cancellation the worker's own finish() then silently overwrites.
 */
export async function cancelJob(db: Db, id: string, reason: string): Promise<JobRow | undefined> {
  const before = await db.select().from(jobs).where(eq(jobs.id, id)).get();
  if (before === undefined) return undefined;
  const transient = withoutTransient(getJobHandler(before.kind), before.payload);
  return await db
    .update(jobs)
    .set({
      status: 'dead',
      lockedBy: null,
      lockedAt: null,
      updatedAt: Date.now(),
      lastError: reason.slice(0, MAX_ERROR_LENGTH),
      ...(transient === undefined ? {} : { payload: transient }),
    })
    .where(and(eq(jobs.id, id), eq(jobs.status, 'pending')))
    .returning()
    .get();
}

/** dead -> pending with a fresh attempt budget. Undefined when the job is not dead. */
export async function reviveDeadJob(db: Db, id: string): Promise<JobRow | undefined> {
  const now = Date.now();
  try {
    return await reviveRow(db, id, now);
  } catch (err) {
    // Another unfinished job holds the same dedupe key (jobs_unfinished_dedupe_uq).
    if (isUniqueViolation(err)) {
      throw new HttpError(
        409,
        'already_queued',
        'A pending or running job with the same key is already queued.',
      );
    }
    throw err;
  }
}

async function reviveRow(db: Db, id: string, now: number): Promise<JobRow | undefined> {
  return await db
    .update(jobs)
    .set({
      status: 'pending',
      attempts: 0,
      runAt: now,
      lockedBy: null,
      lockedAt: null,
      updatedAt: now,
    })
    .where(and(eq(jobs.id, id), eq(jobs.status, 'dead')))
    .returning()
    .get();
}

// ---------------------------------------------------------------------------
// Scheduler

/**
 * For each schedule row: enabled, enqueue its next occurrence (deduped, so at most one
 * pending or running occurrence exists); disabled, drop any pending occurrence. Returns the
 * names whose row could not be used (bad value or cron expression).
 */
export async function materializeSchedules(db: Db, now: number = Date.now()): Promise<string[]> {
  const invalid: string[] = [];
  for (const { kind: name, schedule, userId } of await readSchedules(db)) {
    if (schedule === undefined) {
      invalid.push(name);
      continue;
    }
    if (!schedule.enabled) {
      await dropPendingScheduled(db, name);
      continue;
    }
    const runAt = nextOccurrence(schedule.cron, now);
    if (runAt === undefined) {
      invalid.push(name);
      continue;
    }
    try {
      await insertJob(db, schedule.kind ?? name, schedule.payload ?? {}, {
        runAt,
        dedupeKey: scheduleDedupeKey(name),
        ...(userId === null ? {} : { userId }),
      });
    } catch {
      // A payload the handler's schema rejects: report the row, keep materializing the rest.
      invalid.push(name);
    }
  }
  return invalid;
}

async function safeMaterialize(db: Db, now: number, opts: RunOptions): Promise<void> {
  try {
    const invalid = await materializeSchedules(db, now);
    if (invalid.length > 0) {
      opts.onError?.(new Error(`invalid schedule for: ${invalid.join(', ')}`));
    }
  } catch (err) {
    opts.onError?.(err);
  }
}
