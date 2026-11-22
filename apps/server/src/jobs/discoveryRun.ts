// Discovery engine (FR-D1, D2, D5). One run of one source: iterate the adapter's postings,
// sanitize each (adapters return raw values; nothing downstream sees a posting before
// sanitizePosting), skip duplicates, store the rest as pending results, keep the adapter's
// cursor, and record stats. An adapter error marks the source as failing and is rethrown so the
// runner's backoff retries the run; the next successful run marks the source healthy again. A
// SourceConfigError (unknown org, invalid config) is recorded the same way but not rethrown: no
// retry can fix it, so the job ends after one attempt and the source shows the error.
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getSource, SourceConfigError, type SourceContext } from '../adapters/discoverySource';
import { lockScope, withTransaction, type Db } from '../db/client';
import { users } from '../db/schema';
import {
  errorText,
  ingestRaw,
  knownExternalIds,
  prefilterJudge,
  rankBelowCut,
  type RunStats,
} from '../lib/discoveryIngest';
import { HttpError } from '../lib/errors';
import { isBoardSource } from '../lib/prefilter';
import { racePoint } from '../lib/racePoints';
import type { UserCtx } from '../repos/base';
import {
  createRun,
  finishRun,
  getSourceRow,
  hasRunInProgress,
  hasSucceededRun,
  hasUnfinishedRun,
  prefilterRecall,
  saveSourceCursor,
  setSourceStatus,
  sourceScheduleName,
  splitConfig,
  type DiscoveryResultView,
} from '../repos/discovery';
import { DISCOVERY_RUN_KIND, MULTI_POSTED_PREFIX, MULTI_POSTED_SCORE_CAP } from './discoveryKinds';
import { requireService, type JobHandler } from './registry';
import { obs } from '../obs';
import { workflow } from '../obs/workflow';

export { DISCOVERY_RUN_KIND, MULTI_POSTED_PREFIX, MULTI_POSTED_SCORE_CAP, sourceScheduleName };

/**
 * The most postings a board's first run sends for ranking
 * (https://github.com/bgoleno/opportun/issues/215): a first run brings in the whole board, and
 * ranking all of it could take the budget for days. The rest wait below the cut until the user
 * sends them, having seen the count and the cost.
 */
export const FIRST_RUN_RANK_CAP = 25;

/** Attempts per run: a failing board is retried with backoff, then the job is parked. */
export const DISCOVERY_RUN_MAX_ATTEMPTS = 3;

/**
 * A stdio MCP source spawns its owner's command on the server; only an administrator may
 * configure one (repos/discovery). Re-checked at run time, so a source created by an account
 * that is no longer an administrator (or written some other way) never spawns anything. On the
 * demo, whose administrator is a shared login, none runs, whoever owns it.
 */
async function assertMayRun(
  db: Db,
  userId: string,
  kind: string,
  config: Record<string, unknown>,
  demo: boolean,
): Promise<void> {
  if (kind !== 'mcp' || config.transport !== 'stdio') return;
  if (demo) throw new SourceConfigError('stdio MCP sources do not run on the demo');
  const owner = await db
    .select({ isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (owner?.isAdmin !== true) {
    throw new SourceConfigError('stdio MCP sources run only for an administrator');
  }
}

/** The `skipped` stat on a run that did not start because its source was paused (#310). */
export const SKIPPED_DISABLED = 'source_disabled';
const SKIPPED_DISABLED_TEXT = 'Skipped: the source was paused before this run started.';

/** The `skipped` stat on a run that did not start because another of its source's was going (#269). */
export const SKIPPED_IN_PROGRESS = 'run_in_progress';
const SKIPPED_IN_PROGRESS_TEXT = 'Skipped: a run of this source was already in progress.';

export type DiscoveryRunOutcome =
  | { status: 'done'; runId: string; stats: RunStats; inserted: DiscoveryResultView[] }
  | { status: 'config_error'; runId: string; stats: RunStats; error: string }
  | { status: 'skipped'; reason: 'missing' | 'disabled' | 'in_progress' };

/**
 * Runs one source now. Rethrows an adapter error after recording it on the run and source,
 * except a SourceConfigError, which is recorded and returned as 'config_error'.
 */
export async function runDiscoverySource(
  db: Db,
  ctx: UserCtx,
  sourceId: string,
  sctx: SourceContext,
  /** The discovery.run job this is, so it does not count itself as the run in progress; and
   *  whether this is the demo server (JobServices.demo). */
  opts: { jobId?: string; demo: boolean },
): Promise<DiscoveryRunOutcome> {
  let source;
  try {
    source = await getSourceRow(db, ctx, sourceId);
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 404) {
      return { status: 'skipped', reason: 'missing' };
    }
    throw err;
  }
  if (!source.enabled) {
    // Run now was accepted while the source was on, and it was switched off before the job started
    // (#310). Say so in the run history instead of ending silently. The run carries an error, so
    // it is never taken for a success (hasSucceededRun, the volume figures), and the source's own
    // health and last run are left alone: nothing was fetched.
    const run = await createRun(db, ctx, { sourceId: source.id });
    await finishRun(db, ctx, run.id, {
      error: SKIPPED_DISABLED_TEXT,
      stats: { skipped: SKIPPED_DISABLED },
    });
    return { status: 'skipped', reason: 'disabled' };
  }

  // One run in progress per source (https://github.com/bgoleno/opportun/issues/269). Run now and the
  // schedule queue their jobs under different keys, so the runner can start one while the other
  // runs, and the board would be read twice at once. The run row is the mark: under the source's
  // lock, a run that finds one unfinished while another job of this source is running does not
  // start, and says so in the run history as a paused source's does. Both tests are needed. The
  // row alone would let a run a crash left unfinished stop the source for good, and the job alone
  // would let two runs claimed together each see the other and both stop, or neither.
  await racePoint('discoveryRun.one_per_source');
  const run = await withTransaction(db, async (tx) => {
    await lockScope(tx, `discovery.run_source:${source.id}`);
    if (
      (await hasUnfinishedRun(tx, ctx, source.id)) &&
      (await hasRunInProgress(tx, ctx, source.id, opts.jobId))
    ) {
      const skipped = await createRun(tx, ctx, { sourceId: source.id });
      await finishRun(tx, ctx, skipped.id, {
        error: SKIPPED_IN_PROGRESS_TEXT,
        stats: { skipped: SKIPPED_IN_PROGRESS },
      });
      return null;
    }
    return await createRun(tx, ctx, { sourceId: source.id });
  });
  if (run === null) return { status: 'skipped', reason: 'in_progress' };
  const stats: RunStats = {
    fetched: 0,
    inserted: 0,
    duplicates: 0,
    invalid: 0,
    suppressed: 0,
    filtered: 0,
  };
  const inserted: DiscoveryResultView[] = [];
  const { config, cursor } = splitConfig(source);
  let lastCursor: unknown = cursor;
  let advanced = false;
  // A first run holds everything until it has succeeded (#215): only then is the board's newest
  // known, and a failed attempt sends nothing, so retries cannot add up past the cap.
  const firstRun = isBoardSource(source.kind) && !(await hasSucceededRun(db, ctx, source.id));
  try {
    await assertMayRun(db, source.userId, source.kind, config, opts.demo);
    const adapter = getSource(source.kind);
    const runSctx: SourceContext = {
      ...sctx,
      knownExternalIds: async (ids) => await knownExternalIds(db, ctx, source.id, ids),
    };
    const judge = isBoardSource(source.kind)
      ? await prefilterJudge(db, ctx, source.roleTargetId)
      : null;
    // At each run's start, against the user's decisions as they stand now: it does not latch, so
    // recall falling back below the bar returns new postings to shadow mode (#218).
    const filterActs =
      judge !== null && source.prefilterEnabled && (await prefilterRecall(db, ctx)).on;
    for await (const item of adapter.fetchPostings(runSctx, config, cursor)) {
      stats.fetched += 1;
      lastCursor = item.nextCursor;
      advanced = true;
      await ingestRaw(
        db,
        ctx,
        run.id,
        source.id,
        source.companyId,
        item.posting,
        stats,
        inserted,
        judge,
        filterActs,
        firstRun,
      );
    }
  } catch (err) {
    const detail = errorText(err);
    await withTransaction(db, async (tx) => {
      // Keep the progress made: a retry resumes after the last posting handled.
      if (advanced) await saveSourceCursor(tx, ctx, source.id, lastCursor);
      await finishRun(tx, ctx, run.id, { error: detail, stats: { ...stats } });
      await setSourceStatus(tx, ctx, source.id, 'error', detail);
    });
    sctx.log.warn(
      { 'opportun.source.id': source.id, 'opportun.discovery.source_kind': source.kind, err },
      'discovery run failed',
    );
    runFinished(ctx, source.kind, 'error', stats);
    if (err instanceof SourceConfigError) {
      return { status: 'config_error', runId: run.id, stats, error: detail };
    }
    throw err;
  }
  const sendFirstCut = await withTransaction(db, async (tx) => {
    // A run of this source alongside this one may have got there first (a schedule and Run now each
    // have a job of their own, #267). It sends the 25, so this one sends none. Under a lock and in
    // the transaction that records this run, or on Postgres two could each see no run yet, and send
    // 50 between them.
    let isFirstToFinish = false;
    if (firstRun) {
      await lockScope(tx, `discovery.first_run:${source.id}`);
      isFirstToFinish = !(await hasSucceededRun(tx, ctx, source.id));
    }
    if (advanced) await saveSourceCursor(tx, ctx, source.id, lastCursor);
    await finishRun(tx, ctx, run.id, { stats: { ...stats } });
    await setSourceStatus(tx, ctx, source.id, 'ok', null);
    return isFirstToFinish;
  });
  // After the run is recorded: a stop in between leaves postings below the cut for the user to
  // send, where the other order would let a retry send a second 25.
  if (sendFirstCut) await rankBelowCut(db, ctx, source.id, FIRST_RUN_RANK_CAP);
  runFinished(ctx, source.kind, 'done', stats);
  return { status: 'done', runId: run.id, stats, inserted };
}

/** The discovery.run.finished event (design 14.9): the source's kind, how it ended, its counts. */
function runFinished(ctx: UserCtx, kind: string, outcome: 'done' | 'error', stats: RunStats): void {
  obs.event(
    'discovery.run.finished',
    {
      'opportun.discovery.source_kind': kind,
      'opportun.discovery.run_outcome': outcome,
      'opportun.count.fetched': stats.fetched,
      'opportun.count.inserted': stats.inserted,
      'opportun.count.duplicates': stats.duplicates,
      'opportun.count.invalid': stats.invalid,
      'opportun.count.suppressed': stats.suppressed,
      'opportun.count.filtered': stats.filtered,
    },
    { userId: ctx.userId },
  );
}

const PayloadSchema = z.object({ sourceId: z.string().min(1).max(64) });

export const discoveryRunJob: JobHandler<z.infer<typeof PayloadSchema>> = {
  kind: DISCOVERY_RUN_KIND,
  payloadSchema: PayloadSchema,
  maxAttempts: DISCOVERY_RUN_MAX_ATTEMPTS,
  async run(db, payload, ctx) {
    if (ctx.userId === null) throw new Error(`${DISCOVERY_RUN_KIND} needs a user`);
    const user: UserCtx = { userId: ctx.userId, isAdmin: false };
    const sctx: SourceContext = {
      fetch: requireService(ctx, 'sourceFetch'),
      log: requireService(ctx, 'log'),
    };
    // The discovery_run workflow (design 14.5): its lead_resolve and rank jobs continue it.
    const outcome = await workflow('discovery_run', { userId: user.userId }, () =>
      runDiscoverySource(db, user, payload.sourceId, sctx, {
        jobId: ctx.jobId,
        // Required, never defaulted: a context without it refuses to run, not runs as if off it.
        demo: requireService(ctx, 'demo'),
      }),
    );
    if (outcome.status === 'done') {
      await ctx.setResult({ status: outcome.status, runId: outcome.runId, stats: outcome.stats });
    } else {
      await ctx.setResult(outcome);
    }
  },
};
