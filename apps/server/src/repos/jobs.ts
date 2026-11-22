// The jobs table, as the routes read it (https://github.com/bgoleno/opportun/issues/766;
// docs/architecture.md 6.2): no route queries `jobs` itself. The queue's own reads and writes
// (claiming, retrying, scheduling) stay in jobs/runner.ts. Some reads here are the instance's, not a
// user's (the admin list, the backup schedule), so not every function takes a UserCtx: each says
// whose rows it reads.
import { and, asc, count, desc, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { jobs, type JOB_STATUSES } from '../db/schema';
import type { Db, UserCtx } from './base';
import { ownedBy } from './base';

type JobStatus = (typeof JOB_STATUSES)[number];

/** Whose jobs the list shows: one user's, a set of users' and the instance's own, or everyone's. */
export type JobListScope =
  | { kind: 'user'; userId: string }
  | { kind: 'users_and_instance'; userIds: Iterable<string> }
  | { kind: 'all' };

/**
 * The jobs list, newest change first (#592). Settings > Jobs polls it every 5 s for 200 rows: only
 * the columns the screen shows (never a payload or a result, which can be large), in the order of
 * jobs_updated_at_idx, so its cost does not grow with the done jobs kept in retention. The query
 * itself, for its plan to be checked (test/requestPathReads.test.ts).
 */
export function jobsListQuery(
  db: Db,
  scope: JobListScope,
  opts: { status?: JobStatus | undefined; limit: number },
) {
  const owner =
    scope.kind === 'user'
      ? ownedBy(jobs.userId, scope)
      : scope.kind === 'users_and_instance'
        ? or(isNull(jobs.userId), inArray(jobs.userId, [...scope.userIds]))
        : undefined;
  const where = and(owner, opts.status === undefined ? undefined : eq(jobs.status, opts.status)) as
    SQL | undefined;
  return db
    .select({
      id: jobs.id,
      kind: jobs.kind,
      status: jobs.status,
      attempts: jobs.attempts,
      maxAttempts: jobs.maxAttempts,
      runAt: jobs.runAt,
      lastError: jobs.lastError,
      userId: jobs.userId,
      createdAt: jobs.createdAt,
      updatedAt: jobs.updatedAt,
    })
    .from(jobs)
    .where(where)
    .orderBy(desc(jobs.updatedAt), desc(jobs.id))
    .limit(opts.limit);
}

/** The jobs list (Settings > Jobs): jobsListQuery's rows. */
export async function listJobs(
  db: Db,
  scope: JobListScope,
  opts: { status?: JobStatus | undefined; limit: number },
) {
  return jobsListQuery(db, scope, opts).all();
}

/** A job's owner (null for the instance's own), or undefined when there is no such job. */
export async function jobOwner(db: Db, id: string): Promise<{ userId: string | null } | undefined> {
  return db.select({ userId: jobs.userId }).from(jobs).where(eq(jobs.id, id)).get();
}

/** Whether a job with this id exists, whoever's it is. */
export async function jobExists(db: Db, id: string): Promise<boolean> {
  const row = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, id)).get();
  return row !== undefined;
}

/** The next pending run of a scheduled kind (the instance's), by its schedule's dedupe key. */
export async function nextScheduledRun(
  db: Db,
  kind: string,
  dedupeKey: string,
): Promise<{ runAt: number } | undefined> {
  return db
    .select({ runAt: jobs.runAt })
    .from(jobs)
    .where(and(eq(jobs.kind, kind), eq(jobs.dedupeKey, dedupeKey), eq(jobs.status, 'pending')))
    .orderBy(asc(jobs.runAt))
    .get();
}

/** The most recently changed job of a kind, whoever's: its outcome. */
export async function latestJobOfKind(db: Db, kind: string) {
  return db
    .select({
      status: jobs.status,
      updatedAt: jobs.updatedAt,
      attempts: jobs.attempts,
      lastError: jobs.lastError,
    })
    .from(jobs)
    .where(eq(jobs.kind, kind))
    .orderBy(desc(jobs.updatedAt), desc(jobs.id))
    .get();
}

/** The user's job with this id, if it is one of `kinds`. */
export async function userJobOfKinds(db: Db, ctx: UserCtx, id: string, kinds: readonly string[]) {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, id), inArray(jobs.kind, [...kinds]), ownedBy(jobs.userId, ctx)))
    .get();
}

/** The dedupe keys, among `keys`, of the user's unfinished (pending or running) jobs of `kind`. */
export async function unfinishedDedupeKeys(
  db: Db,
  ctx: UserCtx,
  kind: string,
  keys: readonly string[],
): Promise<(string | null)[]> {
  const rows = await db
    .select({ dedupeKey: jobs.dedupeKey })
    .from(jobs)
    .where(
      and(
        eq(jobs.kind, kind),
        ownedBy(jobs.userId, ctx),
        inArray(jobs.status, ['pending', 'running']),
        inArray(jobs.dedupeKey, [...keys]),
      ),
    )
    .all();
  return rows.map((r) => r.dedupeKey);
}

/** How many of the user's jobs of `kind` are unfinished: queued, or running now. */
export async function countUnfinished(db: Db, ctx: UserCtx, kind: string): Promise<number> {
  const row = await db
    .select({ n: count() })
    .from(jobs)
    .where(
      and(
        ownedBy(jobs.userId, ctx),
        eq(jobs.kind, kind),
        inArray(jobs.status, ['pending', 'running']),
      ),
    )
    .get();
  return row?.n ?? 0;
}
