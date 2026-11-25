// The jobs table, as the routes read it (https://github.com/bgoleno/opportun/issues/766;
// docs/architecture.md 6.2): no route queries `jobs` itself. The queue's own reads and writes
// (claiming, retrying, scheduling) stay in jobs/runner.ts. Some reads here are the instance's, not a
// user's (the admin list, the backup schedule), so not every function takes a UserCtx: each says
// whose rows it reads.
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { JOB_STATUSES, jobs } from '../db/schema';
import type { Db, UserCtx } from './base';
import { ownedBy } from './base';

type JobStatus = (typeof JOB_STATUSES)[number];

/** Whose jobs the list shows: one user's, a set of users' and the instance's own, or everyone's. */
export type JobListScope =
  | { kind: 'user'; userId: string }
  | { kind: 'users_and_instance'; userIds: Iterable<string> }
  | { kind: 'all' };

function inScope(scope: JobListScope): SQL | undefined {
  return scope.kind === 'user'
    ? ownedBy(jobs.userId, scope)
    : scope.kind === 'users_and_instance'
      ? or(isNull(jobs.userId), inArray(jobs.userId, [...scope.userIds]))
      : undefined;
}

/** The statuses Settings > Jobs shows: pending is two, not tried yet and waiting to try again. */
export type JobShownStatus = 'queued' | 'retrying' | Exclude<JobStatus, 'pending'>;

function hasStatus(status: JobStatus | JobShownStatus): SQL | undefined {
  switch (status) {
    case 'queued':
      return and(eq(jobs.status, 'pending'), eq(jobs.attempts, 0));
    case 'retrying':
      return and(eq(jobs.status, 'pending'), gt(jobs.attempts, 0));
    case 'done':
      // Nearly every job kept is done. Written as an equality, SQLite reads them all by
      // jobs_status_run_at_idx and sorts them to find the newest; no index serves this one, so it
      // walks jobs_updated_at_idx as the unfiltered list does (#982).
      return notInArray(
        jobs.status,
        JOB_STATUSES.filter((s) => s !== 'done'),
      );
    default:
      return eq(jobs.status, status);
  }
}

/**
 * The jobs list, newest change first (#592). Settings > Jobs polls it every 5 s for 200 rows: only
 * the columns the screen shows (never a payload or a result, which can be large), in the order of
 * jobs_updated_at_idx, so its cost does not grow with the done jobs kept in retention. The query
 * itself, for its plan to be checked (test/requestPathReads.test.ts).
 */
export function jobsListQuery(
  db: Db,
  scope: JobListScope,
  opts: { status?: JobStatus | JobShownStatus | undefined; limit: number },
) {
  const where = and(inScope(scope), opts.status === undefined ? undefined : hasStatus(opts.status));
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
  opts: { status?: JobStatus | JobShownStatus | undefined; limit: number },
) {
  return jobsListQuery(db, scope, opts).all();
}

/**
 * How many jobs of each shown status the scope has (#982), polled with the list. One statement, so
 * a job that changes meanwhile is counted once. `attempts` is in no index, so it is read for the
 * pending jobs only: with every job in scope, the finished ones are counted from
 * jobs_status_run_at_idx alone.
 */
export function jobCountsQuery(db: Db, scope: JobListScope) {
  const owner = inScope(scope);
  const tried = sql<JobShownStatus>`CASE WHEN ${gt(jobs.attempts, sql`0`)} THEN 'retrying' ELSE 'queued' END`;
  return db
    .select({ status: sql<JobShownStatus>`${jobs.status}`.as('shown'), n: count() })
    .from(jobs)
    .where(and(owner, ne(jobs.status, 'pending')))
    .groupBy(jobs.status)
    .unionAll(
      db
        .select({ status: tried.as('shown'), n: count() })
        .from(jobs)
        .where(and(owner, eq(jobs.status, 'pending')))
        .groupBy(tried),
    );
}

export async function countJobs(
  db: Db,
  scope: JobListScope,
): Promise<Record<JobShownStatus, number>> {
  const counts = { queued: 0, retrying: 0, running: 0, done: 0, dead: 0 };
  for (const row of await jobCountsQuery(db, scope).all()) counts[row.status] = row.n;
  return counts;
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
