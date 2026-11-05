// Discovery engine (FR-D1, D2, D5). One run of one source: iterate the adapter's postings,
// sanitize each (adapters return raw values; nothing downstream sees a posting before
// sanitizePosting), skip duplicates, store the rest as pending results, keep the adapter's
// cursor, and record stats. An adapter error marks the source as failing and is rethrown so the
// runner's backoff retries the run; the next successful run marks the source healthy again. A
// SourceConfigError (unknown org, invalid config) is recorded the same way but not rethrown: no
// retry can fix it, so the job ends after one attempt and the source shows the error.
import { dedupeKey, newId, NormalizedPostingSchema, type NormalizedPosting } from '@opportun/core';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import { getSource, SourceConfigError, type SourceContext } from '../adapters/discoverySource';
import { lockScope, withTransaction, type Db } from '../db/client';
import { jsonText } from '../db/dialect';
import {
  discoveryResults,
  discoveryRuns,
  dismissalFeedback,
  opportunities,
  roleTargets,
  users,
} from '../db/schema';
import {
  loadDeniedCompanies,
  matchDeniedCompany,
  type DeniedCompany,
} from '../lib/deniedCompanies';
import { HttpError } from '../lib/errors';
import { sanitizePosting } from '../lib/postingSanitize';
import { isBoardSource, prefilter, type PrefilterVerdict } from '../lib/prefilter';
import type { Exec, UserCtx } from '../repos/base';
import {
  clearBelowCut,
  createRun,
  finishRun,
  getSourceRow,
  hasSucceededRun,
  insertResult,
  listBelowCut,
  saveSourceCursor,
  setDisposition,
  setSourceStatus,
  sourceScheduleName,
  splitConfig,
  type DiscoveryResultView,
} from '../repos/discovery';
import {
  DISCOVERY_RANK_KIND,
  DISCOVERY_RUN_KIND,
  LEAD_RESOLVE_KIND,
  MULTI_POSTED_PREFIX,
  MULTI_POSTED_SCORE_CAP,
} from './discoveryKinds';
import { requireService, type JobHandler } from './registry';
import { enqueue } from './runner';

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

export interface RunStats {
  fetched: number;
  inserted: number;
  duplicates: number;
  /** Postings that did not survive sanitization (e.g. no company or title left). */
  invalid: number;
  /** Stored, then immediately dismissed, because the company matched the user's denylist
   *  (issue #199) -- counted separately from `inserted` so a run's own history shows this
   *  rather than folding it into an undifferentiated insert count. */
  suppressed: number;
}

type DuplicateCheck = 'duplicate' | 'multi_posted' | 'new';

/**
 * Duplicates: a live (non-dismissed) opportunity with the key; any result with the key the user
 * already decided on (accepted or dismissed), so an attached, force-accepted or merged-away
 * posting is not re-suggested on the next poll; a pending result with the key from this same
 * source; or any earlier result from this same source with the posting's externalId (a repost
 * whose title or location drifted). A pending result from another source makes it multi-posted.
 */
async function checkDuplicate(
  exec: Exec,
  ctx: UserCtx,
  key: string,
  sourceId: string,
  externalId: string | null | undefined,
): Promise<DuplicateCheck> {
  const opp = await exec
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(
      and(
        eq(opportunities.userId, ctx.userId),
        eq(opportunities.dedupeKey, key),
        ne(opportunities.stage, 'dismissed'),
      ),
    )
    .get();
  if (opp !== undefined) return 'duplicate';
  // The indexed dedupe-key lookup first; the externalId scan (a JSON extract over this
  // source's results) runs only when the key alone did not settle it as a duplicate.
  const rows = await exec
    .select({ disposition: discoveryResults.disposition, sourceId: discoveryRuns.sourceId })
    .from(discoveryResults)
    .innerJoin(discoveryRuns, eq(discoveryRuns.id, discoveryResults.runId))
    .where(and(eq(discoveryResults.userId, ctx.userId), eq(discoveryResults.dedupeKey, key)))
    .all();
  if (rows.some((r) => r.disposition !== 'pending')) return 'duplicate';
  const pending = rows.filter((r) => r.disposition === 'pending');
  if (pending.some((r) => r.sourceId === sourceId)) return 'duplicate';
  if (externalId != null) {
    const same = await exec
      .select({ id: discoveryResults.id })
      .from(discoveryResults)
      .innerJoin(discoveryRuns, eq(discoveryRuns.id, discoveryResults.runId))
      .where(
        and(
          eq(discoveryResults.userId, ctx.userId),
          eq(discoveryRuns.sourceId, sourceId),
          eq(jsonText(discoveryResults.posting, 'externalId'), externalId),
        ),
      )
      .get();
    if (same !== undefined) return 'duplicate';
  }
  return pending.length > 0 ? 'multi_posted' : 'new';
}

/** The externalIds among `ids` stored by an earlier run of `sourceId` (SourceContext). */
async function knownExternalIds(
  exec: Exec,
  ctx: UserCtx,
  sourceId: string,
  ids: readonly string[],
): Promise<ReadonlySet<string>> {
  if (ids.length === 0) return new Set();
  const externalId = jsonText(discoveryResults.posting, 'externalId');
  const rows = await exec
    .select({ externalId })
    .from(discoveryResults)
    .innerJoin(discoveryRuns, eq(discoveryRuns.id, discoveryResults.runId))
    .where(
      and(
        eq(discoveryResults.userId, ctx.userId),
        eq(discoveryRuns.sourceId, sourceId),
        inArray(externalId, [...ids]),
      ),
    )
    .all();
  return new Set(rows.flatMap((r) => (r.externalId === null ? [] : [r.externalId])));
}

/**
 * Marks a just-inserted result dismissed because its company matched the user's own denylist
 * (issue #199): stored and auditable, same as any other decided result (visible in the Decided
 * view, undoable via the restore route), never silently dropped. The dismissal reason
 * (`denied_company`) is excluded from `refineDiscoveryPrompt`'s counting -- this is not new
 * information about role fit, the denylist already fully captures it.
 */
async function suppressForDenylist(
  tx: Exec,
  ctx: UserCtx,
  result: DiscoveryResultView,
  denied: DeniedCompany,
): Promise<DiscoveryResultView> {
  await tx
    .insert(dismissalFeedback)
    .values({
      id: newId(),
      userId: ctx.userId,
      kind: 'dismissal',
      resultId: result.id,
      opportunityId: null,
      reason: 'denied_company',
      note: denied.name,
      at: Date.now(),
    })
    .run();
  return await setDisposition(tx, ctx, result.id, 'dismissed');
}

/** The pre-filter's verdict on one posting (#217), against the targets its source ranks for. */
type Judge = (posting: NormalizedPosting) => PrefilterVerdict | null;

/**
 * The verdict for a board's postings: against the source's own role target when it has one, as
 * ranking does, else against every active one. Read once per run.
 */
async function prefilterJudge(db: Db, ctx: UserCtx, roleTargetId: string | null): Promise<Judge> {
  const targets = await db
    .select()
    .from(roleTargets)
    .where(
      roleTargetId === null
        ? and(eq(roleTargets.userId, ctx.userId), eq(roleTargets.active, true))
        : and(eq(roleTargets.userId, ctx.userId), eq(roleTargets.id, roleTargetId)),
    )
    .all();
  return (posting) => prefilter(posting, targets);
}

/** Stores one sanitized posting unless it is a duplicate, then immediately dismisses it if its
 *  company matched the user's denylist (`sourceCompanyId`: the source's own linked company,
 *  when it is a per-company board tracker; see deniedCompanies.ts for the full match order). */
async function ingest(
  db: Db,
  ctx: UserCtx,
  runId: string,
  sourceId: string,
  sourceCompanyId: string | null,
  posting: NormalizedPosting,
  judge: Judge | null,
  holdBelowCut: boolean,
  sourceCommunicationId?: string,
): Promise<DiscoveryResultView | 'duplicate'> {
  const key = dedupeKey(posting.company, posting.title, posting.location);
  return await withTransaction(db, async (tx) => {
    // discovery_results has no unique index, and two runs of a source can overlap: on Postgres this
    // lock is all that keeps them from both passing the check. It is the user's, not the source's,
    // because the check also looks across their other sources (multi_posted).
    // https://github.com/bgoleno/opportun/issues/267
    await lockScope(tx, `discovery.ingest:${ctx.userId}`);
    const check = await checkDuplicate(tx, ctx, key, sourceId, posting.externalId);
    if (check === 'duplicate') return 'duplicate';
    const partial = posting.descriptionMd == null || posting.descriptionMd === '';
    const result = await insertResult(tx, ctx, {
      runId,
      posting,
      dedupeKey: key,
      resolution: partial ? 'needs_capture' : 'full',
      aiRationale: check === 'multi_posted' ? MULTI_POSTED_PREFIX : null,
      rankSkipReason: holdBelowCut ? 'below_cut' : null,
      ...(sourceCommunicationId === undefined ? {} : { sourceCommunicationId }),
      // Shadow mode (#217): stored and measured; what is ranked below does not depend on it.
      prefilter: judge === null ? null : judge(posting),
    });
    const denied = matchDeniedCompany(await loadDeniedCompanies(tx, ctx), sourceCompanyId, posting);
    return denied === undefined ? result : await suppressForDenylist(tx, ctx, result, denied);
  });
}

/**
 * Work queued for each stored result: a partial lead (no description) is resolved against ATS
 * sources first, and lead resolution then queues its ranking (FR-D7); a full posting is ranked
 * right away (FR-D4).
 */
async function enqueueFollowUps(
  db: Db,
  ctx: UserCtx,
  result: Pick<DiscoveryResultView, 'id' | 'resolution'>,
): Promise<void> {
  const kind = result.resolution === 'needs_capture' ? LEAD_RESOLVE_KIND : DISCOVERY_RANK_KIND;
  await enqueue(
    db,
    kind,
    { resultId: result.id },
    { dedupeKey: `${kind}:${result.id}`, userId: ctx.userId },
  );
}

/**
 * Sends up to `limit` of a source's postings below the cut, newest first, the way any new posting
 * goes: from here on the budget and its wait apply. Queued before the reason goes, so a stop between
 * the two leaves a posting with a job and a stale reason, which the job clears, and never one with
 * no reason and no job, which nothing would ever rank. Returns how many it sent.
 */
export async function rankBelowCut(
  db: Db,
  ctx: UserCtx,
  sourceId: string,
  limit: number,
): Promise<number> {
  const held = (await listBelowCut(db, ctx, sourceId)).slice(0, limit);
  for (const result of held) {
    await enqueueFollowUps(db, ctx, result);
    await clearBelowCut(db, ctx, result.id);
  }
  return held.length;
}

/**
 * The one path every posting takes into the queue, whatever its source: sanitize, re-validate,
 * dedupe, store, queue follow-ups. Updates `stats` and collects stored results in `inserted`. A
 * posting held below the cut is stored the same way and queues nothing yet.
 */
async function ingestRaw(
  db: Db,
  ctx: UserCtx,
  runId: string,
  sourceId: string,
  sourceCompanyId: string | null,
  raw: NormalizedPosting,
  stats: RunStats,
  inserted: DiscoveryResultView[],
  judge: Judge | null,
  holdBelowCut: boolean,
  sourceCommunicationId?: string,
): Promise<void> {
  const parsed = NormalizedPostingSchema.safeParse(sanitizePosting(raw));
  if (!parsed.success) {
    stats.invalid += 1;
    return;
  }
  const outcome = await ingest(
    db,
    ctx,
    runId,
    sourceId,
    sourceCompanyId,
    parsed.data,
    judge,
    holdBelowCut,
    sourceCommunicationId,
  );
  if (outcome === 'duplicate') {
    stats.duplicates += 1;
  } else if (outcome.disposition === 'dismissed') {
    // Denylist-suppressed (issue #199): stored and auditable, but already decided, so it does
    // not join `inserted` (nothing downstream should rank or surface it) and does not queue
    // AI ranking or lead resolution -- there is nothing left for either to decide.
    stats.suppressed += 1;
  } else {
    stats.inserted += 1;
    inserted.push(outcome);
    if (!holdBelowCut) await enqueueFollowUps(db, ctx, outcome);
  }
}

/**
 * Stores postings a channel delivers by itself rather than through an adapter run (job alert
 * emails, Task 12): one run of `sourceId` holding them, through the same sanitize, dedupe and
 * follow-up path as an adapter's postings. A lead seen before (same key or externalId on this
 * source, or already decided) is a duplicate, so a re-delivered digest adds nothing.
 */
export async function insertLeads(
  db: Db,
  ctx: UserCtx,
  postings: NormalizedPosting[],
  sourceId: string,
  /**
   * The message these postings were parsed out of (design D3b), so each lead can link back to
   * the mail it came from instead of sending the user to search their mailbox for it.
   */
  sourceCommunicationId?: string,
): Promise<{ runId: string; stats: RunStats; inserted: DiscoveryResultView[] }> {
  const run = await createRun(db, ctx, { sourceId });
  const source = await getSourceRow(db, ctx, sourceId);
  const stats: RunStats = { fetched: 0, inserted: 0, duplicates: 0, invalid: 0, suppressed: 0 };
  const inserted: DiscoveryResultView[] = [];
  for (const posting of postings) {
    stats.fetched += 1;
    await ingestRaw(
      db,
      ctx,
      run.id,
      sourceId,
      source.companyId,
      posting,
      stats,
      inserted,
      // Job-alert emails are never pre-filtered (owner's decision 5 on #190).
      null,
      // A job alert is not a board, so no first-run cap either.
      false,
      sourceCommunicationId,
    );
  }
  await withTransaction(db, async (tx) => {
    await finishRun(tx, ctx, run.id, { stats: { ...stats } });
    await setSourceStatus(tx, ctx, sourceId, 'ok', null);
  });
  return { runId: run.id, stats, inserted };
}

/**
 * A stdio MCP source spawns its owner's command on the server; only an administrator may
 * configure one (repos/discovery). Re-checked at run time, so a source created by an account
 * that is no longer an administrator (or written some other way) never spawns anything.
 */
async function assertMayRun(
  db: Db,
  userId: string,
  kind: string,
  config: Record<string, unknown>,
): Promise<void> {
  if (kind !== 'mcp' || config.transport !== 'stdio') return;
  const owner = await db
    .select({ isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (owner?.isAdmin !== true) {
    throw new SourceConfigError('stdio MCP sources run only for an administrator');
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export type DiscoveryRunOutcome =
  | { status: 'done'; runId: string; stats: RunStats; inserted: DiscoveryResultView[] }
  | { status: 'config_error'; runId: string; stats: RunStats; error: string }
  | { status: 'skipped'; reason: 'missing' | 'disabled' };

/**
 * Runs one source now. Rethrows an adapter error after recording it on the run and source,
 * except a SourceConfigError, which is recorded and returned as 'config_error'.
 */
export async function runDiscoverySource(
  db: Db,
  ctx: UserCtx,
  sourceId: string,
  sctx: SourceContext,
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
  if (!source.enabled) return { status: 'skipped', reason: 'disabled' };

  const run = await createRun(db, ctx, { sourceId: source.id });
  const stats: RunStats = { fetched: 0, inserted: 0, duplicates: 0, invalid: 0, suppressed: 0 };
  const inserted: DiscoveryResultView[] = [];
  const { config, cursor } = splitConfig(source);
  let lastCursor: unknown = cursor;
  let advanced = false;
  // A first run holds everything until it has succeeded (#215): only then is the board's newest
  // known, and a failed attempt sends nothing, so retries cannot add up past the cap.
  const firstRun = isBoardSource(source.kind) && !(await hasSucceededRun(db, ctx, source.id));
  try {
    await assertMayRun(db, source.userId, source.kind, config);
    const adapter = getSource(source.kind);
    const runSctx: SourceContext = {
      ...sctx,
      knownExternalIds: async (ids) => await knownExternalIds(db, ctx, source.id, ids),
    };
    const judge = isBoardSource(source.kind)
      ? await prefilterJudge(db, ctx, source.roleTargetId)
      : null;
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
    sctx.log.warn({ sourceId: source.id, kind: source.kind, err }, 'discovery run failed');
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
  return { status: 'done', runId: run.id, stats, inserted };
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
    const outcome = await runDiscoverySource(db, user, payload.sourceId, sctx);
    if (outcome.status === 'done') {
      await ctx.setResult({ status: outcome.status, runId: outcome.runId, stats: outcome.stats });
    } else {
      await ctx.setResult(outcome);
    }
  },
};
