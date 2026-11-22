// The job queue (https://github.com/bgoleno/opportun/issues/788): putting a job on the jobs table
// (enqueue, deduped), and the schedules the runner materializes. In lib/ so repos/ and lib/ queue
// work without importing jobs/; the runner that claims and runs jobs stays in jobs/runner.ts.
import { newId } from '@opportun/core';
import { CronExpressionParser } from 'cron-parser';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { z } from 'zod';
import { rawGet, type Db, type Exec } from '../db/client';
import { jobs, settings } from '../db/schema';
import { racePoint } from './racePoints';
import { currentTraceparent } from '../obs';
import { queuedHandlerOf } from './jobHandlerLookup';

export const DEFAULT_MAX_ATTEMPTS = 5;

const UNFINISHED: (typeof jobs.$inferSelect)['status'][] = ['pending', 'running'];

export interface EnqueueOptions {
  runAt?: number;
  /** Skip the enqueue (returning the existing id) while an unfinished job has kind + key. */
  dedupeKey?: string;
  /** The user the job acts for; scopes GET /jobs and per-user lookups such as imports. */
  userId?: string;
  /**
   * Continue the caller's trace in the job (design.md 14.6): stores the active span's W3C
   * traceparent in jobs.trace_context. Only while collection is on, and only when a span is
   * active; otherwise the column stays null. A deduped enqueue leaves the holder's own value.
   */
  continueTrace?: boolean;
}

export async function insertJob(
  db: Exec,
  kind: string,
  payload: unknown,
  opts: EnqueueOptions,
): Promise<string> {
  const handler = queuedHandlerOf(kind);
  const value = handler === undefined ? payload : handler.payloadSchema.parse(payload);
  await racePoint('jobs.enqueue');
  const traceContext = opts.continueTrace === true ? currentTraceparent() : null;
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
      traceContext,
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
                            dedupe_key, user_id, trace_context, created_at, updated_at)
          VALUES (${row.id}, ${row.kind}, ${JSON.stringify(row.payload)}, ${row.runAt},
                  ${row.attempts}, ${row.maxAttempts}, ${row.status}, ${row.dedupeKey},
                  ${row.userId}, ${row.traceContext}, ${row.createdAt}, ${row.updatedAt})
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
  // A transaction too (#686): a job queued with the write that calls for it, so neither lands alone.
  db: Exec,
  kind: string,
  payload: unknown,
  opts: EnqueueOptions = {},
): Promise<string> {
  return insertJob(db, kind, payload, opts);
}

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

export const scheduleDedupeKey = (name: string): string => `${SCHEDULE_PREFIX}${name}`;

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
export async function dropPendingScheduled(exec: Exec, name: string): Promise<void> {
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
