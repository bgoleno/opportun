// The messages that have no classification, and why (https://github.com/bgoleno/opportun/issues/1050).
// The wait is on the row, not in a job, as a posting's for the discovery budget is
// (jobs/discoveryRankWaiting.ts): a restart, a failed job or a long outage loses nothing, and the
// sealed text of the job does not live longer for it.
import type { ClassifyWait } from '@opportun/core';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import type { Exec } from '../db/client';
import { communications, jobs } from '../db/schema';
import { readBudget, readSetting, writeSetting } from '../lib/ai';
import { CLASSIFY_JOB_KIND } from '../lib/mailClassifyQueue';
import { racePoint } from '../lib/racePoints';
import type { Db, UserCtx } from './base';
import { ownedBy } from './base';
import { spentTodayUsd, startOfUtcDay } from './taskRuns';

const DAY_MS = 86_400_000;

/**
 * How long a message is tried again, from when it was received here. Older mail would make
 * opportunities at New, and suggest stages, from what is long over.
 */
export const CLASSIFY_WAIT_DAYS = 30;

/**
 * The share of the day's budget for comms.classify that later tries may begin a call under. New mail's
 * own jobs have no such limit, so a backlog leaves them at least the rest of it.
 */
export const CLASSIFY_WAITING_SHARE = 0.5;

/** The reasons a later try takes every time. */
const TAKEN = ['budget_exceeded', 'provider_error'] as const;

/** Begun on an earlier UTC day. */
const triedBefore = (now: number): SQL => lt(communications.classifyTriedAt, startOfUtcDay(now));

/** Unclassified mail that may reach the model: passed by the filter and not rejected. */
const unclassified = (): SQL =>
  and(
    isNull(communications.classification),
    isNull(communications.rejectedAt),
    or(isNull(communications.triageDecision), ne(communications.triageDecision, 'filtered')),
  ) as SQL;

/** Received recently enough that the server does something about it by itself. */
const recent = (now: number): SQL =>
  gte(communications.createdAt, now - CLASSIFY_WAIT_DAYS * DAY_MS);

/** Has no classify job that is not over, whatever made it. */
const noUnfinishedJob = (): SQL => sql`NOT EXISTS (
  SELECT 1 FROM ${jobs}
  WHERE ${jobs.kind} = ${CLASSIFY_JOB_KIND}
    AND ${jobs.dedupeKey} = ${`${CLASSIFY_JOB_KIND}:`} || ${communications.id}
    AND ${jobs.status} IN ('pending', 'running'))`;

/** A message a later try may take now. */
const waits = (now: number): SQL =>
  and(
    unclassified(),
    recent(now),
    or(
      inArray(communications.classifyWait, [...TAKEN]),
      // Set before the call and cleared by its end: one from an earlier day ended with its process. So
      // a message that ends the process does it once a day, not every hour (#588).
      and(eq(communications.classifyWait, 'trying'), triedBefore(now)),
      // Nor one that fails, as its call may have been paid for; a first job's at once.
      and(
        eq(communications.classifyWait, 'failed'),
        or(isNull(communications.classifyTriedAt), triedBefore(now)),
      ),
    ),
    noUnfinishedJob(),
  ) as SQL;

/**
 * What the backfill of a new key takes (jobs/classifyBackfill): all that no later try does by itself,
 * the old ones too, whatever they say. Not one the user has blocked, nor one whose try is under way.
 */
export const backfillTakes = (now: number): SQL =>
  and(
    unclassified(),
    or(
      isNull(communications.classifyWait),
      inArray(communications.classifyWait, ['no_key', 'invalid_output']),
      and(
        lt(communications.createdAt, now - CLASSIFY_WAIT_DAYS * DAY_MS),
        ne(communications.classifyWait, 'blocked'),
        or(ne(communications.classifyWait, 'trying'), triedBefore(now)),
      ),
    ),
  ) as SQL;

/**
 * Says why the message is not classified. One statement whose own condition is that it still is not,
 * and may be: a classification, a reject or a block that came meanwhile stands. `blocked` is the end.
 */
export async function setClassifyWait(
  exec: Exec,
  ctx: UserCtx,
  id: string,
  wait: ClassifyWait,
): Promise<boolean> {
  const set = await exec
    .update(communications)
    .set({ classifyWait: wait, updatedAt: Date.now() })
    .where(
      and(
        ownedBy(communications.userId, ctx),
        eq(communications.id, id),
        unclassified(),
        or(isNull(communications.classifyWait), ne(communications.classifyWait, 'blocked')),
      ),
    )
    .returning({ id: communications.id })
    .all();
  return set.length > 0;
}

/** `failed` for a message whose first job is over and has said nothing. */
export async function setClassifyFailedIfUnsaid(
  exec: Exec,
  ctx: UserCtx,
  id: string,
): Promise<void> {
  await exec
    .update(communications)
    .set({ classifyWait: 'failed', updatedAt: Date.now() })
    .where(
      and(
        ownedBy(communications.userId, ctx),
        eq(communications.id, id),
        unclassified(),
        isNull(communications.classifyWait),
      ),
    )
    .run();
}

/**
 * A later try of the message begins, if it still waits: committed before the call, so that a try which
 * ends the process is not made again before the next UTC day. What it said before, to put back if
 * nothing comes of the try; null when it does not wait any more.
 */
export async function beginClassifyTry(
  db: Db,
  ctx: UserCtx,
  id: string,
  now: number,
): Promise<ClassifyWait | null> {
  const row = await db
    .select({ wait: communications.classifyWait })
    .from(communications)
    .where(and(ownedBy(communications.userId, ctx), eq(communications.id, id)))
    .get();
  if (row === undefined || row.wait === null) return null;
  await racePoint('classifyWaiting.read');
  const begun = await db
    .update(communications)
    .set({ classifyWait: 'trying', classifyTriedAt: now })
    .where(
      and(
        ownedBy(communications.userId, ctx),
        eq(communications.id, id),
        eq(communications.classifyWait, row.wait),
        waits(now),
      ),
    )
    .returning({ id: communications.id })
    .all();
  return begun.length === 0 ? null : row.wait;
}

/** The caller's waiting messages: those not tried today first, the newest of each first. */
export async function listWaitingMessageIds(
  db: Db,
  ctx: UserCtx,
  now: number = Date.now(),
): Promise<string[]> {
  const triedToday = sql`CASE WHEN ${communications.classifyTriedAt} >= ${startOfUtcDay(now)} THEN 1 ELSE 0 END`;
  const rows = await db
    .select({ id: communications.id })
    .from(communications)
    .where(and(ownedBy(communications.userId, ctx), waits(now)))
    .orderBy(asc(triedToday), desc(communications.sentAt), desc(communications.id))
    .all();
  return rows.map((r) => r.id);
}

/** Everyone with a message that waits (the hourly sweep's question). */
export async function usersWithWaitingMessages(
  db: Db,
  now: number = Date.now(),
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: communications.userId })
    .from(communications)
    .where(waits(now))
    .all();
  return rows.map((r) => r.userId);
}

/**
 * Whether a message of the caller's says their key was refused: nothing is sent until that ends
 * (clearClassifyKeyRejected). Of any age, as that is: a new key's backfill takes old mail too, and each
 * would be sent to a key that is refused.
 */
export async function classifyKeyRejected(exec: Exec, ctx: UserCtx): Promise<boolean> {
  const row = await exec
    .select({ id: communications.id })
    .from(communications)
    .where(
      and(
        ownedBy(communications.userId, ctx),
        eq(communications.classifyWait, 'key_rejected'),
        unclassified(),
      ),
    )
    .limit(1)
    .get();
  return row !== undefined;
}

/**
 * Ends that stop: what the refused key left waits for a later try, or is too old for one. The caller
 * holds keyChangeScope.
 */
export async function clearClassifyKeyRejected(
  exec: Exec,
  ctx: UserCtx,
  now: number = Date.now(),
): Promise<void> {
  await exec
    .update(communications)
    .set({ classifyWait: 'provider_error', updatedAt: now })
    .where(
      and(ownedBy(communications.userId, ctx), eq(communications.classifyWait, 'key_rejected')),
    )
    .run();
}

const changedKey = (userId: string): string => `classify_key_changed:${userId}`;

/**
 * When what the caller's mail is classified with last changed (a key, or the task's model policy), for
 * telling a 401 of a call that began before (#261); 0 if it never has. Its own, not ranking's: a policy
 * for mail says nothing of ranking's calls.
 */
export async function readClassifyKeyChangedAt(exec: Exec, ctx: UserCtx): Promise<number> {
  const parsed = z.number().safeParse(await readSetting(exec, ctx, changedKey(ctx.userId)));
  return parsed.success ? parsed.data : 0;
}

export async function writeClassifyKeyChangedAt(
  exec: Exec,
  ctx: UserCtx,
  at: number,
): Promise<void> {
  await writeSetting(exec, ctx, changedKey(ctx.userId), at);
}

/** Whether a later try may begin a call: today's spend on mail is under its share of the budget. */
export async function classifyWaitingHasRoom(
  db: Db,
  ctx: UserCtx,
  now: number = Date.now(),
): Promise<boolean> {
  const { perTaskDailyUsd } = await readBudget(db, ctx);
  const spent = await spentTodayUsd(db, ctx, 'comms.classify', now);
  return spent < perTaskDailyUsd * CLASSIFY_WAITING_SHARE;
}

/** Of the caller's unclassified messages, how many say what; numbers alone. */
export type UnclassifiedCounts = Record<
  Exclude<ClassifyWait, 'blocked'> | 'no_longer_tried',
  number
>;

/** These wait for the user, whatever their age. */
const OF_THE_USER: ReadonlySet<ClassifyWait> = new Set([
  'key_rejected',
  'no_key',
  'invalid_output',
]);

/**
 * What the Inbox says of the mail that is not classified. Not one whose first job is not over (it says
 * nothing yet), nor one the user has blocked since. One that only its age keeps from a later try is
 * counted apart.
 */
export async function countUnclassified(
  db: Db,
  ctx: UserCtx,
  now: number = Date.now(),
): Promise<UnclassifiedCounts> {
  const before = now - CLASSIFY_WAIT_DAYS * DAY_MS;
  const rows = await db
    .select({
      wait: communications.classifyWait,
      n: sql<number>`count(*)`,
      old: sql<number>`sum(CASE WHEN ${communications.createdAt} < ${before} THEN 1 ELSE 0 END)`,
    })
    .from(communications)
    .where(
      and(
        ownedBy(communications.userId, ctx),
        unclassified(),
        isNotNull(communications.classifyWait),
      ),
    )
    .groupBy(communications.classifyWait)
    .all();
  const out: UnclassifiedCounts = {
    budget_exceeded: 0,
    provider_error: 0,
    failed: 0,
    trying: 0,
    key_rejected: 0,
    no_key: 0,
    invalid_output: 0,
    no_longer_tried: 0,
  };
  for (const row of rows) {
    if (row.wait === null || row.wait === 'blocked') continue;
    const old = OF_THE_USER.has(row.wait) ? 0 : Number(row.old);
    out[row.wait] = Number(row.n) - old;
    out.no_longer_tried += old;
  }
  return out;
}
