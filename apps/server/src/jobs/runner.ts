// Durable SQLite job queue (NFR-OPS4, design section 8). Jobs are claimed atomically with
// UPDATE ... RETURNING, retried with capped exponential backoff, and parked as `dead` once
// they run out of attempts. One runner per process: on start, jobs a crashed process left
// `running` go back to `pending`. The scheduler turns settings rows schedule:<kind> (a cron
// expression) into the next pending job for that kind.
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { newId } from '@opportun/core';
import { CronExpressionParser } from 'cron-parser';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isUniqueViolation, rawGet, runCount, type Db, type Exec } from '../db/client';
import { claimNextJob, type ClaimedJob } from '../db/dialect';
import { HttpError } from '../lib/errors';
import { jobs, settings } from '../db/schema';
import { racePoint } from '../lib/racePoints';
import { getJobHandler, type JobContext, type JobHandler, type JobServices } from './registry';

export const DEFAULT_MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 30_000;
const MAX_JITTER_MS = 10_000;
const MAX_DELAY_MS = 3_600_000;
const MAX_ERROR_LENGTH = 2000;
const DEFAULT_INTERVAL_MS = 1000;
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
 * worker at once. Everything absent is limited only by the pool, which is the point: a user's
 * import no longer waits behind a long sync.
 */
export const DEFAULT_KIND_LIMITS: Readonly<Record<string, number>> = {
  'gmail.sync': 1,
  'gmail.sync_all': 1,
  backup: 1,
  'company.ats_detect': 2,
};

function envWorkers(): number {
  const raw = process.env.OPPORTUN_JOB_WORKERS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_WORKERS;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : DEFAULT_WORKERS;
}

export type JobRow = typeof jobs.$inferSelect;
export type JobStatus = JobRow['status'];
const UNFINISHED: JobStatus[] = ['pending', 'running'];

/** min(2^attempts * 30s + jitter(0-10s), 1h). */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const jitter = Math.floor(Math.min(Math.max(random(), 0), 1) * MAX_JITTER_MS);
  return Math.min(2 ** attempts * BASE_DELAY_MS + jitter, MAX_DELAY_MS);
}

export interface EnqueueOptions {
  runAt?: number;
  /** Skip the enqueue (returning the existing id) while an unfinished job has kind + key. */
  dedupeKey?: string;
  /** The user the job acts for; scopes GET /jobs and per-user lookups such as imports. */
  userId?: string;
}

async function insertJob(
  db: Db,
  kind: string,
  payload: unknown,
  opts: EnqueueOptions,
): Promise<string> {
  const handler = getJobHandler(kind);
  const value = handler === undefined ? payload : handler.payloadSchema.parse(payload);
  await racePoint('jobs.enqueue');
  // The partial unique index jobs_unfinished_dedupe_uq (migration 0019) admits one unfinished
  // job per (kind, dedupe_key): insert-or-nothing, then read the holder. If the holder
  // finished between the two statements the key is free again, so try once more.
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = Date.now();
    const row = {
      id: newId(),
      kind,
      payload: value ?? null,
      runAt: opts.runAt ?? now,
      attempts: 0,
      maxAttempts: handler?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      status: 'pending' as const,
      dedupeKey: opts.dedupeKey ?? null,
      userId: opts.userId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    if (opts.dedupeKey === undefined) {
      await db.insert(jobs).values(row).run();
      return row.id;
    }
    // Targeted at the partial unique index (jobs_unfinished_dedupe_uq, migration 0019), so
    // any other constraint still fails loudly. Raw SQL: drizzle's SQLite builder renders a
    // conflict target's WHERE after DO NOTHING, which a partial index does not accept.
    const inserted = await rawGet<{ id: string }>(
      db,
      sql`INSERT INTO jobs (id, kind, payload, run_at, attempts, max_attempts, status,
                            dedupe_key, user_id, created_at, updated_at)
          VALUES (${row.id}, ${row.kind}, ${JSON.stringify(row.payload)}, ${row.runAt},
                  ${row.attempts}, ${row.maxAttempts}, ${row.status}, ${row.dedupeKey},
                  ${row.userId}, ${row.createdAt}, ${row.updatedAt})
          ON CONFLICT (kind, dedupe_key)
            WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'running')
          DO NOTHING
          RETURNING id`,
    );
    if (inserted !== undefined) return inserted.id;
    const holder = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.kind, kind),
          eq(jobs.dedupeKey, opts.dedupeKey),
          inArray(jobs.status, UNFINISHED),
        ),
      )
      .get();
    if (holder !== undefined) return holder.id;
  }
  throw new Error(`enqueue ${kind}: dedupe key kept changing hands`);
}

/**
 * Adds a job. The payload is validated against the registered handler's schema (a kind with
 * no handler yet is stored as-is). Returns the new job id, or the id of the unfinished job
 * that holds the same kind + dedupeKey.
 */
export async function enqueue(
  db: Db,
  kind: string,
  payload: unknown,
  opts: EnqueueOptions = {},
): Promise<string> {
  return insertJob(db, kind, payload, opts);
}

export interface RunOptions {
  /** Clock (tests pin it to drive backoff deterministically). */
  now?: () => number;
  /** Jitter source in [0, 1). */
  random?: () => number;
  workerId?: string;
  services?: Partial<JobServices>;
  /** Failures outside a handler (e.g. the database went away). */
  onError?: (err: unknown) => void;
}

const defaultWorkerId = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;

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
): Promise<void> {
  await db
    .update(jobs)
    .set({
      status,
      lockedBy: null,
      lockedAt: null,
      updatedAt: now,
      ...(error === undefined ? {} : { lastError: error.slice(0, MAX_ERROR_LENGTH) }),
      ...(payload === undefined ? {} : { payload }),
    })
    .where(eq(jobs.id, id))
    .run();
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

async function processJob(db: Db, job: ClaimedJob, opts: RunOptions): Promise<void> {
  const now = opts.now ?? Date.now;
  const log = opts.services?.log;
  const handler = getJobHandler(job.kind);
  if (handler === undefined) {
    const reason = `no handler registered for kind ${job.kind}`;
    log?.error({ jobId: job.id, kind: job.kind }, reason);
    await finish(db, job.id, 'dead', now(), reason);
    return;
  }
  // Decoded by the claim; undefined when the stored payload is not JSON.
  const parsed = handler.payloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    // A stored payload that no longer validates will never succeed: no retries.
    log?.error(
      { jobId: job.id, kind: job.kind, err: parsed.error },
      'invalid stored payload; job marked dead',
    );
    await finish(db, job.id, 'dead', now(), `invalid payload: ${parsed.error.message}`);
    return;
  }
  const ctx: JobContext = {
    jobId: job.id,
    userId: job.userId,
    attempt: job.attempts,
    maxAttempts: job.maxAttempts,
    services: opts.services ?? {},
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
  try {
    await handler.run(db, parsed.data, ctx);
  } catch (err) {
    const at = now();
    const fields = {
      jobId: job.id,
      kind: job.kind,
      attempt: job.attempts,
      maxAttempts: job.maxAttempts,
      err,
    };
    if (job.attempts >= job.maxAttempts) {
      log?.error(fields, 'job exhausted its retries; marked dead');
      await finish(db, job.id, 'dead', at, errorText(err), transient);
    } else {
      log?.warn(fields, 'job failed; will retry');
      await db
        .update(jobs)
        .set({
          status: 'pending',
          runAt: at + backoffMs(job.attempts, opts.random),
          lockedBy: null,
          lockedAt: null,
          lastError: errorText(err).slice(0, MAX_ERROR_LENGTH),
          updatedAt: at,
        })
        .where(eq(jobs.id, job.id))
        .run();
    }
    return;
  }
  await finish(db, job.id, 'done', now(), undefined, transient);
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
export async function recoverStaleJobs(db: Db): Promise<number> {
  return await runCount(
    db
      .update(jobs)
      .set({ status: 'pending', lockedBy: null, lockedAt: null, updatedAt: Date.now() })
      .where(eq(jobs.status, 'running')),
  );
}

export interface Runner {
  /** Stops polling and resolves once the in-flight job (if any) has finished. */
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
  } = {},
): Runner {
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const workers = Math.max(1, opts.workers ?? envWorkers());
  const limits = opts.kindLimits ?? DEFAULT_KIND_LIMITS;
  const clock = opts.now ?? Date.now;
  const workerId = opts.workerId ?? defaultWorkerId;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;

  /** How many jobs of each kind are running right now, for the per-kind ceilings. */
  const activeByKind = new Map<string, number>();
  const atCap = (): string[] =>
    [...activeByKind.entries()]
      .filter(([kind, n]) => n >= (limits[kind] ?? Number.POSITIVE_INFINITY))
      .map(([kind]) => kind);

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
      if (job !== undefined) activeByKind.set(job.kind, (activeByKind.get(job.kind) ?? 0) + 1);
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
        await processJob(db, job, opts);
        await safeMaterialize(db, clock(), opts);
      } catch (err) {
        opts.onError?.(err);
      } finally {
        release(job.kind);
      }
    }
  };

  const schedule = (delay: number) => {
    timer = setTimeout(tick, delay);
    timer.unref();
  };
  const track = (work: Promise<void>) => {
    inFlight = work.finally(() => {
      inFlight = undefined;
      if (!stopped) schedule(interval);
    });
  };
  function tick(): void {
    // Every worker swallows its own failures, so this resolves when the pool is idle.
    track(Promise.all(Array.from({ length: workers }, () => workerLoop())).then(() => undefined));
  }
  // Startup work starts now (stop() waits for it): orphaned jobs go back to pending, then
  // schedules materialize; the first poll follows immediately.
  inFlight = (async () => {
    try {
      await recoverStaleJobs(db);
      await safeMaterialize(db, clock(), opts);
    } catch (err) {
      opts.onError?.(err);
    }
  })().finally(() => {
    inFlight = undefined;
    if (!stopped) schedule(0);
  });

  return {
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await inFlight;
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

export const SCHEDULE_PREFIX = 'schedule:';

/**
 * A schedule row's value. The row key is `schedule:<name>`; by default the job kind is the
 * name and the payload `{}`. A named schedule (e.g. `schedule:discovery.run:<sourceId>`) sets
 * `kind` and `payload` so many rows can drive one job kind with different payloads.
 */
export interface Schedule {
  cron: string;
  enabled: boolean;
  kind?: string | undefined;
  payload?: Record<string, unknown> | undefined;
}

/** A bare cron string is an enabled schedule; the object form can switch it off. */
const ScheduleValue = z.union([
  z
    .string()
    .min(1)
    .transform((cron): Schedule => ({ cron, enabled: true })),
  z.object({
    cron: z.string().min(1),
    enabled: z.boolean().default(true),
    kind: z.string().min(1).max(100).optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
]);

const scheduleDedupeKey = (name: string): string => `${SCHEDULE_PREFIX}${name}`;

/** The next occurrence strictly after `now`, or undefined for an invalid expression. */
export function nextOccurrence(cron: string, now: number): number | undefined {
  try {
    return CronExpressionParser.parse(cron, { currentDate: new Date(now) })
      .next()
      .getTime();
  } catch {
    return undefined;
  }
}

/** The shortest spacing a user-supplied schedule may have: at most one run an hour. */
export const MIN_USER_CRON_INTERVAL_MS = 60 * 60 * 1000;
/** Occurrences sampled for the spacing check (enough to span one full matching hour). */
const USER_CRON_SAMPLES = 10;

/**
 * Why a user-supplied cron is refused, or null when it is acceptable: it must parse, use the five
 * standard fields (no seconds field), and leave at least an hour between occurrences.
 */
export function userCronProblem(cron: string, now: number = Date.now()): string | null {
  let it: ReturnType<typeof CronExpressionParser.parse>;
  try {
    it = CronExpressionParser.parse(cron, { currentDate: new Date(now) });
  } catch {
    return 'must be a valid cron expression';
  }
  if (cron.trim().split(/\s+/).length !== 5) {
    return 'must have five fields (minute hour day month weekday); a seconds field is not supported';
  }
  let prev: number | undefined;
  for (let i = 0; i < USER_CRON_SAMPLES && it.hasNext(); i++) {
    const at = it.next().getTime();
    if (prev !== undefined && at - prev < MIN_USER_CRON_INTERVAL_MS) {
      return 'must run at most once an hour';
    }
    prev = at;
  }
  return prev === undefined ? 'must be a valid cron expression' : null;
}

/** Drops the pending occurrence a schedule row materialized (its dedupe key is the row key). */
async function dropPendingScheduled(exec: Exec, name: string): Promise<void> {
  await exec
    .delete(jobs)
    .where(and(eq(jobs.dedupeKey, scheduleDedupeKey(name)), eq(jobs.status, 'pending')))
    .run();
}

/**
 * Writes schedule:<name>; a pending occurrence of the old schedule is dropped. `userId` makes
 * the row (and the jobs it materializes) belong to that user, so deleting the user removes it.
 */
export async function setSchedule(
  db: Exec,
  name: string,
  schedule: Schedule,
  userId: string | null = null,
): Promise<void> {
  const now = Date.now();
  await db
    .insert(settings)
    .values({ key: scheduleDedupeKey(name), userId, value: schedule, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: schedule, userId, updatedAt: now } })
    .run();
  await dropPendingScheduled(db, name);
}

/** Deletes schedule:<name> and its pending occurrence. */
export async function removeSchedule(db: Exec, name: string): Promise<void> {
  await db
    .delete(settings)
    .where(eq(settings.key, scheduleDedupeKey(name)))
    .run();
  await dropPendingScheduled(db, name);
}

/** Creates schedule:<kind> with `cron` unless a row (possibly disabled) already exists. */
export async function seedSchedule(db: Db, kind: string, cron: string): Promise<void> {
  await db
    .insert(settings)
    .values({
      key: scheduleDedupeKey(kind),
      userId: null,
      value: { cron, enabled: true } satisfies Schedule,
      updatedAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();
}

export async function readSchedules(
  db: Db,
): Promise<{ kind: string; schedule: Schedule | undefined; userId: string | null }[]> {
  // Every schedule row is written by server code: user-facing settings routes only write
  // their own fixed per-user keys, never a schedule: key.
  const rows = await db
    .select({ key: settings.key, value: settings.value, userId: settings.userId })
    .from(settings)
    .where(like(settings.key, `${SCHEDULE_PREFIX}%`))
    .all();
  return rows.map((row) => {
    const parsed = ScheduleValue.safeParse(row.value);
    return {
      kind: row.key.slice(SCHEDULE_PREFIX.length),
      schedule: parsed.success ? parsed.data : undefined,
      userId: row.userId,
    };
  });
}

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
