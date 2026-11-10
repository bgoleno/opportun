// Discovery's ranking cost and each board's posting volume, from the app's own records
// (https://github.com/bgoleno/opportun/issues/209, #190 slice 1; tl's ruling on the issue): the
// figures #190's section 3 estimates, so the owner reads them in the app, never by a query run by
// hand. Read-only over task_runs and discovery_runs, scoped to the caller: no AI call, no
// outbound request, nothing stored. The arithmetic runs here, not in SQL, so it reads the same on
// SQLite and Postgres.
import { and, asc, count, desc, eq, gte, inArray, isNotNull } from 'drizzle-orm';
import { discoveryResults, discoveryRuns, discoverySources, taskRuns } from '../db/schema';
import type { Db, UserCtx } from './base';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The rank windows Settings > AI usage shows. */
const RANK_WINDOWS = [7, 30] as const;
/** The days a board's posting rate is averaged over. */
const VOLUME_DAYS = 14;
/** The task whose calls each new board posting costs. */
const RANK_TASK = 'discovery.rank';

export interface TokenSpread {
  median: number;
  p90: number;
}

export interface RankWindow {
  days: number;
  /** Every discovery.rank call in the window, errors included. */
  calls: number;
  errors: number;
  /** Over the calls that ranked (status ok); null when there were none. */
  inputTokens: TokenSpread | null;
  outputTokens: TokenSpread | null;
  avgCostUsd: number | null;
  /** Every call in the window, errors included: an error can still spend tokens (tl). */
  totalCostUsd: number;
}

export interface SourceVolume {
  sourceId: string;
  kind: string;
  /** The job count the newest run that succeeded saw; null before any succeeded. */
  openJobs: number | null;
  /** Stored new postings a day; null with no run after its first success ("no data yet"). */
  newPerDay: number | null;
  /** The whole days the rate covers, for its label: 14 once the span reaches 14 days, else the
   *  span rounded down and at least 1; 0 with no rate. The rate itself divides by the exact
   *  span (at least 1 day). */
  days: number;
  /** Each stored posting is ranked once, except those the pre-filter held (#218). */
  rankCallsPerDay: number | null;
  /** rankCallsPerDay times the 30-day average cost per call; null when either is unknown. */
  costPerDayUsd: number | null;
  /** Postings waiting below the first-run cut for the user to send (#215). */
  belowCut: number;
  /** What sending them would cost at the 30-day average cost per call; null with no average. */
  belowCutCostUsd: number | null;
}

export interface DiscoveryCostFigures {
  rank: RankWindow[];
  sources: SourceVolume[];
}

/** The median of sorted numbers: the middle one, or the mean of the middle two. */
function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted.at(mid) ?? 0;
  return sorted.length % 2 === 1 ? hi : ((sorted.at(mid - 1) ?? 0) + hi) / 2;
}

/** The 90th percentile by nearest rank: the smallest value at or above 90% of the calls. */
function p90(sorted: number[]): number {
  return sorted.at(Math.ceil(0.9 * sorted.length) - 1) ?? 0;
}

function spread(values: number[]): TokenSpread | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  return { median: median(sorted), p90: p90(sorted) };
}

/** A whole number from a run's stats, or null when the run did not record one. */
function statNumber(stats: Record<string, unknown> | null, key: string): number | null {
  const value = stats === null ? undefined : new Map(Object.entries(stats)).get(key);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export async function discoveryCostFigures(
  db: Db,
  ctx: UserCtx,
  now = Date.now(),
): Promise<DiscoveryCostFigures> {
  // ---- discovery.rank over the longest window, split by window below.
  const longest = Math.max(...RANK_WINDOWS);
  const calls = await db
    .select({
      createdAt: taskRuns.createdAt,
      status: taskRuns.status,
      inputTokens: taskRuns.inputTokens,
      outputTokens: taskRuns.outputTokens,
      estCost: taskRuns.estCost,
    })
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.userId, ctx.userId),
        eq(taskRuns.taskKey, RANK_TASK),
        gte(taskRuns.createdAt, now - longest * DAY_MS),
      ),
    )
    .all();
  const rank = RANK_WINDOWS.map((days): RankWindow => {
    const inWindow = calls.filter((c) => c.createdAt >= now - days * DAY_MS);
    const ranked = inWindow.filter((c) => c.status === 'ok');
    return {
      days,
      calls: inWindow.length,
      errors: inWindow.length - ranked.length,
      inputTokens: spread(ranked.map((c) => c.inputTokens)),
      outputTokens: spread(ranked.map((c) => c.outputTokens)),
      avgCostUsd:
        ranked.length === 0 ? null : ranked.reduce((s, c) => s + c.estCost, 0) / ranked.length,
      totalCostUsd: inWindow.reduce((s, c) => s + c.estCost, 0),
    };
  });
  const costPerCall = rank.find((r) => r.days === 30)?.avgCostUsd ?? null;

  // ---- each board source: the ATS kinds, which poll one employer's board.
  const sources = (
    await db
      .select({ id: discoverySources.id, kind: discoverySources.kind })
      .from(discoverySources)
      .where(eq(discoverySources.userId, ctx.userId))
      .orderBy(asc(discoverySources.createdAt), asc(discoverySources.id))
      .all()
  ).filter((s) => s.kind.startsWith('ats_'));
  if (sources.length === 0) return { rank, sources: [] };

  const runs = await db
    .select({
      sourceId: discoveryRuns.sourceId,
      startedAt: discoveryRuns.startedAt,
      stats: discoveryRuns.stats,
      error: discoveryRuns.error,
    })
    .from(discoveryRuns)
    .where(
      and(
        eq(discoveryRuns.userId, ctx.userId),
        inArray(
          discoveryRuns.sourceId,
          sources.map((s) => s.id),
        ),
        isNotNull(discoveryRuns.finishedAt),
      ),
    )
    .orderBy(desc(discoveryRuns.startedAt))
    .all();

  const belowCutRows = await db
    .select({ sourceId: discoveryRuns.sourceId, n: count() })
    .from(discoveryResults)
    .innerJoin(discoveryRuns, eq(discoveryRuns.id, discoveryResults.runId))
    .where(
      and(
        eq(discoveryResults.userId, ctx.userId),
        eq(discoveryResults.disposition, 'pending'),
        eq(discoveryResults.rankSkipReason, 'below_cut'),
      ),
    )
    .groupBy(discoveryRuns.sourceId)
    .all();
  const belowCutOf = new Map(belowCutRows.map((r) => [r.sourceId, Number(r.n)]));

  return {
    rank,
    sources: sources.map((s): SourceVolume => {
      // A run skipped because its source was paused (#310), or ended by a server stop (#323), kept
      // no count: it is neither a run that succeeded nor one that stored postings it recorded, so it
      // says nothing about volume.
      const own = runs.filter(
        (r) =>
          r.sourceId === s.id &&
          r.stats?.skipped === undefined &&
          r.stats?.interrupted === undefined,
      ); // newest first
      // A failed run still finishes with the stats it reached, and an error (discoveryRun.ts's
      // catch block): open jobs and the backfill come only from runs that succeeded (tl on #212).
      const succeeded = own.filter((r) => r.error === null);
      const openJobs = statNumber(succeeded.at(0)?.stats ?? null, 'fetched');
      // tl's ruling: the first run that succeeded stored the whole board, so it, and any failed
      // run before it, are left out; the window runs from the later of 14 days ago and that
      // run, to now. A later run counts even if it failed: the postings it stored are real.
      const backfill = succeeded.at(-1);
      const later =
        backfill === undefined ? [] : own.filter((r) => r.startedAt > backfill.startedAt);
      const belowCut = belowCutOf.get(s.id) ?? 0;
      const none = {
        sourceId: s.id,
        kind: s.kind,
        openJobs,
        newPerDay: null,
        days: 0,
        rankCallsPerDay: null,
        costPerDayUsd: null,
        belowCut,
        belowCutCostUsd: costPerCall === null ? null : belowCut * costPerCall,
      };
      if (backfill === undefined || later.length === 0) return none;
      const start = Math.max(now - VOLUME_DAYS * DAY_MS, backfill.startedAt);
      const inWindow = later.filter((r) => r.startedAt >= start);
      if (inWindow.length === 0) return none;
      // tl's rule on #212: divide by the exact span, so a young board is not divided by days it
      // has not run (rounding up gave 5 a day where 9.6 were stored). At least 1 day, so a run
      // hours after the backfill does not extrapolate a day from a few hours; at most 14. The
      // label's days are the span rounded down, at least 1: under 14 it reads "(n days)".
      const span = (now - start) / DAY_MS;
      const divisor = Math.min(VOLUME_DAYS, Math.max(1, span));
      const days = span >= VOLUME_DAYS ? VOLUME_DAYS : Math.max(1, Math.floor(span));
      const stored = inWindow.reduce((sum, r) => sum + (statNumber(r.stats, 'inserted') ?? 0), 0);
      const newPerDay = stored / divisor;
      // A run from before the filter acted has no such stat, and held nothing.
      const held = inWindow.reduce((sum, r) => sum + (statNumber(r.stats, 'filtered') ?? 0), 0);
      const rankCallsPerDay = (stored - held) / divisor;
      return {
        ...none,
        newPerDay,
        days,
        rankCallsPerDay,
        costPerDayUsd: costPerCall === null ? null : rankCallsPerDay * costPerCall,
      };
    }),
  };
}
