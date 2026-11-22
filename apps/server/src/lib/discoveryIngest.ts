// Storing postings as discovery results (https://github.com/bgoleno/opportun/issues/763): the
// sanitize, dedupe, denylist and pre-filter path every posting takes, and insertLeads, which runs
// it for leads that arrive outside a source run (alert mail, a capture). In lib/ so the alert-mail
// adapter and the capture route store leads without importing the discovery-run job.
import { dedupeKey, newId, NormalizedPostingSchema, type NormalizedPosting } from '@opportun/core';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { isLockTimeout, lockScope, withTransaction, type Db } from '../db/client';
import { jsonText } from '../db/dialect';
import {
  discoveryResults,
  discoveryRuns,
  dismissalFeedback,
  opportunities,
  roleTargets,
} from '../db/schema';
import { loadDeniedCompanies, matchDeniedCompany, type DeniedCompany } from './deniedCompanies';
import { sanitizePosting } from './postingSanitize';
import { prefilter, type PrefilterVerdict } from './prefilter';
import { racePoint } from './racePoints';
import type { Exec, UserCtx } from '../repos/base';
import {
  clearBelowCut,
  clearFiltered,
  createRun,
  finishRun,
  getResult,
  getSourceRow,
  insertResult,
  listBelowCut,
  setDisposition,
  setSourceStatus,
  type DiscoveryResultView,
  ingestScope,
} from '../repos/discovery';
import {
  DISCOVERY_RANK_KIND,
  LEAD_RESOLVE_KIND,
  MULTI_POSTED_PREFIX,
} from '../jobs/discoveryKinds';
import { enqueue } from '../jobs/runner';
import { continuesTrace } from '../obs/workflow';

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
  /** Of `inserted`, those the pre-filter held: stored, and no ranking call (#218). */
  filtered: number;
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
export async function knownExternalIds(
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
export async function prefilterJudge(
  db: Db,
  ctx: UserCtx,
  roleTargetId: string | null,
): Promise<Judge> {
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
  filterActs: boolean,
  holdBelowCut: boolean,
  sourceCommunicationId?: string,
  lockTimeoutMs?: number,
): Promise<DiscoveryResultView | 'duplicate'> {
  const key = dedupeKey(posting.company, posting.title, posting.location);
  return await withTransaction(db, async (tx) => {
    // Two runs of a source can overlap: on Postgres this lock is all that keeps them from both
    // passing the check.
    await lockScope(
      tx,
      ingestScope(ctx),
      lockTimeoutMs === undefined ? {} : { timeoutMs: lockTimeoutMs },
    );
    const check = await checkDuplicate(tx, ctx, key, sourceId, posting.externalId);
    if (check === 'duplicate') return 'duplicate';
    await racePoint('discovery.ingest.locked');
    const partial = posting.descriptionMd == null || posting.descriptionMd === '';
    const verdict = judge === null ? null : judge(posting);
    const result = await insertResult(tx, ctx, {
      runId,
      posting,
      dedupeKey: key,
      resolution: partial ? 'needs_capture' : 'full',
      aiRationale: check === 'multi_posted' ? MULTI_POSTED_PREFIX : null,
      // Filtered goes first: below the cut it would be sent by Rank these, and ranked unasked.
      rankSkipReason:
        filterActs && verdict?.outcome === 'filtered'
          ? 'filtered'
          : holdBelowCut
            ? 'below_cut'
            : null,
      ...(sourceCommunicationId === undefined ? {} : { sourceCommunicationId }),
      // Stored and measured either way (#217).
      prefilter: verdict,
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
export async function enqueueFollowUps(
  db: Db,
  ctx: UserCtx,
  result: Pick<DiscoveryResultView, 'id' | 'resolution'>,
  opts: { live?: boolean } = {},
): Promise<void> {
  const kind = result.resolution === 'needs_capture' ? LEAD_RESOLVE_KIND : DISCOVERY_RANK_KIND;
  await enqueue(
    db,
    kind,
    // A ranking the user clicked for is made live, never in a batch (#441); a lead carries it on.
    { resultId: result.id, ...(opts.live === true ? { live: true } : {}) },
    // Continues the discovery_run trace when queued from inside it (14.6), not otherwise.
    { dedupeKey: `${kind}:${result.id}`, userId: ctx.userId, continueTrace: continuesTrace() },
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
 * Rank anyway (#218): a posting the pre-filter held goes the way any new posting goes, so the budget
 * and its wait apply, but live, never in a batch: someone clicked for it (#441). Queued before the
 * reason goes, as rankBelowCut. Returns how many it sent: none if it is not held any more, so a
 * second press does nothing and needs no error.
 */
export async function rankAnyway(db: Db, ctx: UserCtx, id: string): Promise<number> {
  const result = await getResult(db, ctx, id);
  if (result.disposition !== 'pending' || result.rankSkipReason !== 'filtered') return 0;
  await enqueueFollowUps(db, ctx, result, { live: true });
  await clearFiltered(db, ctx, id);
  return 1;
}

/**
 * The one path every posting takes into the queue, whatever its source: sanitize, re-validate,
 * dedupe, store, queue follow-ups. Updates `stats` and collects stored results in `inserted`. A
 * posting held below the cut is stored the same way and queues nothing yet.
 */
export async function ingestRaw(
  db: Db,
  ctx: UserCtx,
  runId: string,
  sourceId: string,
  sourceCompanyId: string | null,
  raw: NormalizedPosting,
  stats: RunStats,
  inserted: DiscoveryResultView[],
  judge: Judge | null,
  filterActs: boolean,
  holdBelowCut: boolean,
  sourceCommunicationId?: string,
  lockTimeoutMs?: number,
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
    filterActs,
    holdBelowCut,
    sourceCommunicationId,
    lockTimeoutMs,
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
    if (outcome.rankSkipReason === 'filtered') {
      stats.filtered += 1;
    } else if (!holdBelowCut) {
      await enqueueFollowUps(db, ctx, outcome);
    }
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
  /**
   * How long each posting waits for the user's ingest lock, at most (Postgres). The capture
   * route passes CAPTURE_SLOT.lockTimeoutMs (https://github.com/bgoleno/opportun/issues/309);
   * alert mail keeps the usual wait.
   */
  opts: { lockTimeoutMs?: number } = {},
): Promise<{ runId: string; stats: RunStats; inserted: DiscoveryResultView[] }> {
  const run = await createRun(db, ctx, { sourceId });
  const source = await getSourceRow(db, ctx, sourceId);
  const stats: RunStats = {
    fetched: 0,
    inserted: 0,
    duplicates: 0,
    invalid: 0,
    suppressed: 0,
    filtered: 0,
  };
  const inserted: DiscoveryResultView[] = [];
  try {
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
        false,
        // A job alert is not a board, so no first-run cap either.
        false,
        sourceCommunicationId,
        opts.lockTimeoutMs,
      );
    }
  } catch (err) {
    // The run ends with why, or the source's history would show it running for good: a capture
    // refused at its lock wait (#309) is an expected end now (tl on
    // https://github.com/bgoleno/opportun/pull/318). The source's own health is left alone: a
    // channel's status says nothing about one capture.
    // A lock wait that ran out is the capture's busy refusal, not a fault: say it as the capture
    // dialog does, not in the database's words (#324). Anything else keeps its error as it was.
    const error = isLockTimeout(err) ? CAPTURE_BUSY_RUN_TEXT : errorText(err);
    await finishRun(db, ctx, run.id, { error, stats: { ...stats } });
    throw err;
  }
  await withTransaction(db, async (tx) => {
    await finishRun(tx, ctx, run.id, { stats: { ...stats } });
    await setSourceStatus(tx, ctx, sourceId, 'ok', null);
  });
  return { runId: run.id, stats, inserted };
}

export function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** A capture's run refused at its lock wait (#309), in Run history (#324). */
const CAPTURE_BUSY_RUN_TEXT =
  'Not saved: another capture of yours was still being saved. Capture it again in a few seconds.';
