// Resume match reports (issue #175): the resume.match AI task's output is otherwise computed
// and handed back once, never kept, so navigating away and returning loses it. Latest only,
// not history (see schema.sqlite.ts resumeMatchReports): one row per (resume, opportunity).
import { and, eq, sql } from 'drizzle-orm';
import { resumeMatchReports, tailoringSessions, type MatchReport } from '../db/schema';
import type { Db, UserCtx } from './base';

export interface MatchReportRow {
  report: MatchReport;
  scoredAt: number;
}

/** The stored report for a pair, undefined when this resume was never scored against it. */
export async function getMatchReport(
  db: Db,
  ctx: UserCtx,
  resumeId: string,
  opportunityId: string,
): Promise<MatchReportRow | undefined> {
  return await db
    .select({ report: resumeMatchReports.report, scoredAt: resumeMatchReports.scoredAt })
    .from(resumeMatchReports)
    .where(
      and(
        eq(resumeMatchReports.userId, ctx.userId),
        eq(resumeMatchReports.resumeId, resumeId),
        eq(resumeMatchReports.opportunityId, opportunityId),
      ),
    )
    .get();
}

/** Upserts the report for a pair, replacing whatever was there; returns the new scoredAt. */
export async function putMatchReport(
  db: Db,
  ctx: UserCtx,
  resumeId: string,
  opportunityId: string,
  report: MatchReport,
): Promise<number> {
  const scoredAt = Date.now();
  await db
    .insert(resumeMatchReports)
    .values({ userId: ctx.userId, resumeId, opportunityId, report, scoredAt })
    .onConflictDoUpdate({
      target: [resumeMatchReports.resumeId, resumeMatchReports.opportunityId],
      set: { report, scoredAt },
    })
    .run();
  return scoredAt;
}

/**
 * Whether a report scored at scoredAt is stale: a tailoring session for the resume completed
 * after it, so the document the report described may no longer be what is on screen. MAX
 * ignores the still-open sessions (acceptedAt null) on both dialects, so one query answers it.
 *
 * scoredAt and acceptedAt are each an independent Date.now() call (putMatchReport here,
 * completeSession in repos/tailoring.ts), so they can land in the same millisecond -- not a
 * theoretical case, issue #294 caught it firing intermittently in this exact test file. A tie
 * is genuinely ambiguous (the data cannot say which happened first), so this is >=, not >:
 * between a false "stale" (the user re-scores, costing a model call) and a false "not stale" (a
 * fresh-looking badge on a report describing a document that has since changed -- precisely the
 * harm this flag exists to prevent), the second is worse, so the tie breaks toward stale.
 *
 * A monotonic counter instead of a timestamp would remove the tie rather than break it, and was
 * considered and declined: it costs a column and a migration to resolve an ambiguity that exists
 * only inside a single millisecond on a single-user application.
 */
export async function isMatchStale(
  db: Db,
  ctx: UserCtx,
  resumeId: string,
  scoredAt: number,
): Promise<boolean> {
  const row = await db
    .select({ latestAcceptedAt: sql<number | null>`max(${tailoringSessions.acceptedAt})` })
    .from(tailoringSessions)
    .where(and(eq(tailoringSessions.userId, ctx.userId), eq(tailoringSessions.resumeId, resumeId)))
    .get();
  const latestAcceptedAt = row?.latestAcceptedAt ?? null;
  return latestAcceptedAt !== null && latestAcceptedAt >= scoredAt;
}
