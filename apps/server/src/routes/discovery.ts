// Discovery API (FR-D1, D3, FR-O7, FR-O10): the review queue (list, accept or attach, dismiss),
// opportunity merge, and the user's discovery sources (CRUD, run now, run history).
import { enqueue } from '../lib/jobQueue';
import { rankAnyway, rankBelowCut } from '../lib/discoveryIngest';
import {
  cardKey,
  dedupeKey,
  DISCOVERY_SOURCE_KINDS,
  DISMISS_REASONS,
  DISPOSITIONS,
  newId,
  NormalizedPostingSchema,
  PREFILTER_OUTCOMES,
  PREFILTER_RULES,
  RANK_SKIP_REASONS,
  RESOLUTIONS,
} from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { hasSource } from '../adapters/discoverySource';
import { DISCOVERY_RUN_KIND } from '../lib/jobKinds';
import { resumeAfterUndo } from '../jobs/discoveryRankWaiting';
import { HttpError } from '../lib/errors';
import { httpLink } from '../lib/httpLink';
import { openOpportunityFor, recordAlsoPosted } from '../lib/openOpportunity';
import { racePoint } from '../lib/racePoints';
import {
  createSource,
  deleteSource,
  getResult,
  getSourceRow,
  hasRunInProgress,
  listResults,
  prefilterRecall,
  listRuns,
  listSources,
  RESULT_SORTS,
  RUN_SORTS,
  setDisposition,
  SOURCE_SORTS,
  unsuppressResult,
  updateSource,
} from '../repos/discovery';
import { createOpportunity, getOpportunity, mergeOpportunities } from '../repos/opportunities';
import { dismissalFeedback } from '../db/schema';
import { discoveryCostFigures } from '../repos/discoveryFigures';
import { IdParams, listQuery, optionalText, pageOf } from './common';
import { OpportunityView } from './opportunities';
import { lockScope, withTransaction, type Db, type Exec } from '../db/client';
import type { DiscoveryResultView } from '../repos/discovery';
import type { UserCtx } from '../repos/base';

const ResultSchema = z.object({
  id: z.string(),
  runId: z.string(),
  sourceId: z.string(),
  sourceKind: z.enum(DISCOVERY_SOURCE_KINDS),
  roleTargetId: z.string().nullable(),
  posting: NormalizedPostingSchema,
  dedupeKey: z.string().nullable(),
  aiScore: z.number().nullable(),
  aiRationale: z.string().nullable(),
  /** The pre-filter's verdict (#217, shadow mode); null for a posting it did not judge. */
  prefilterOutcome: z.enum(PREFILTER_OUTCOMES).nullable(),
  prefilterRule: z.enum(PREFILTER_RULES).nullable(),
  prefilterScore: z.number().nullable(),
  /** Why ranking was skipped (#210), until the result is ranked; null otherwise. */
  rankSkipReason: z.enum(RANK_SKIP_REASONS).nullable(),
  /**
   * When its ranking began waiting for the discovery budget (#214), or when a provider failure
   * last used its turn; null when it is not waiting.
   */
  rankDeferredAt: z.number().int().nullable(),
  /** When the batch its ranking is in was sent (#441); null when it is in none. */
  rankBatchSentAt: z.number().int().nullable(),
  resolution: z.enum(RESOLUTIONS),
  resolvedSourceRef: z.string().nullable(),
  disposition: z.enum(DISPOSITIONS),
  opportunityId: z.string().nullable(),
  /**
   * The message this lead was parsed out of (design D3b), as the two identifiers a deep link
   * back to it is built from. Null for a lead that came from a board rather than from mail.
   */
  sourceMailChannel: z.string().nullable(),
  sourceMailExternalId: z.string().nullable(),
  /** Why a dismissed result was dismissed (issue #199); null unless disposition is dismissed. */
  dismissReason: z.string().nullable(),
  dismissNote: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

const PrefilterRecallSchema = z.object({
  /** Accepted postings the pre-filter judged: what the figure is based on. */
  positives: z.number().int(),
  /** How many of them it would have kept. */
  kept: z.number().int(),
  /** kept / positives, 0 to 1; null with none yet. */
  recall: z.number().nullable(),
  /** Whether recall holds, so that board sources act on the verdicts (#218). */
  on: z.boolean(),
  neededRecall: z.number(),
  neededPositives: z.number().int(),
  /** Postings it judged when they arrived, and those it filtered. */
  judged: z.number().int(),
  filtered: z.number().int(),
});

const ResultListQuery = listQuery([...RESULT_SORTS.keys()]).extend({
  disposition: z.enum(DISPOSITIONS).optional(),
  sourceId: z.string().min(1).max(64).optional(),
});

const AcceptBody = z
  .object({
    /** Link the result to this existing opportunity instead of creating one (FR-O10). */
    attachTo: z.string().min(1).max(64).optional(),
    /** Create past a dedupe match (the opportunity create path's force). */
    force: z.boolean().optional(),
  })
  .strict();

const DismissBody = z
  .object({
    reason: z.enum(DISMISS_REASONS).optional(),
    note: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

/**
 * Per-request cap for bulk accept/dismiss (#184). Synchronous, not queued: a queued job would
 * hide per-item outcomes behind a job record, which is exactly what the user triaging a few
 * hundred results needs to see directly (which items failed and why, not a count).
 *
 * Grounded in #186's measurement, not a round number: createOpportunity's near-miss dedupe
 * scan (a full, unfiltered scan of the user's own opportunities) makes per-item cost climb
 * through a batch as each create grows the next scan's baseline, superlinear rather than
 * flat. At the user's current ~145-opportunity baseline, 50 sequential accepts measured
 * 119-147ms on SQLite and 686ms-1.3s on Postgres (the high end attributed to contention
 * noise, not the code path) against a ~5s budget for the whole request. Extrapolating that
 * same climb to 100 items stays comfortably inside budget; 150 does not leave real margin.
 * 100 is picked over #186's own suggested 100-150 range for that reason. This cost is tied
 * to the user's total opportunity count, which only grows, so the margin behind this number
 * shrinks over time even if this constant never changes; revisit it if #186's baseline count
 * moves materially.
 */
const MAX_BULK_SIZE = 100;

const BulkIdsBody = z
  .object({ ids: z.array(z.string().min(1).max(64)).min(1).max(MAX_BULK_SIZE) })
  .strict();

const BulkDismissBody = z
  .object({
    ids: z.array(z.string().min(1).max(64)).min(1).max(MAX_BULK_SIZE),
    reason: z.enum(DISMISS_REASONS),
    note: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

/** What happened to one id in a bulk request. `duplicate` and `error` are not the same claim:
 *  a duplicate is the system working (the posting is already tracked); an error is not.
 *  `attached` is `duplicate`'s chain-aware sibling (issue #209): not a conflict needing the
 *  user to resolve it, but this id's own, expected outcome as a non-primary member of a
 *  location group, linked to the opportunity its group's primary produced. */
const BULK_OUTCOMES = [
  'accepted',
  'attached',
  'dismissed',
  'restored',
  'already_decided',
  'duplicate',
  'not_found',
  'error',
] as const;
type BulkOutcome = (typeof BULK_OUTCOMES)[number];

const BulkItemResultSchema = z.object({
  id: z.string(),
  outcome: z.enum(BULK_OUTCOMES),
  /** Present only for `duplicate`, `attached` and `already_decided`: the opportunity this id
   *  already matches, was linked to, or was accepted into (when there still is one). */
  existingId: z.string().optional(),
  /** Present only for `error`: why, for the one item that failed. */
  message: z.string().optional(),
});

const BulkResultSchema = z.object({ results: z.array(BulkItemResultSchema) });

interface BulkItemResult {
  id: string;
  outcome: BulkOutcome;
  existingId?: string;
  message?: string;
}

const MergeBody = z.object({ otherId: z.string().min(1).max(64) }).strict();

const SourceSchema = z.object({
  id: z.string(),
  kind: z.enum(DISCOVERY_SOURCE_KINDS),
  config: z.record(z.string(), z.unknown()),
  enabled: z.boolean(),
  prefilterEnabled: z.boolean(),
  scheduleCron: z.string().nullable(),
  roleTargetId: z.string().nullable(),
  companyId: z.string().nullable(),
  lastRunAt: z.number().int().nullable(),
  status: z.enum(['ok', 'error']),
  statusDetail: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

const sourceFields = {
  config: z.record(z.string().max(100), z.unknown()),
  enabled: z.boolean(),
  prefilterEnabled: z.boolean(),
  scheduleCron: optionalText(100),
  roleTargetId: z.string().min(1).max(64).nullable(),
  companyId: z.string().min(1).max(64).nullable(),
};
const SourceCreate = z
  .object({ kind: z.enum(DISCOVERY_SOURCE_KINDS), ...sourceFields })
  .partial({
    config: true,
    enabled: true,
    prefilterEnabled: true,
    scheduleCron: true,
    roleTargetId: true,
    companyId: true,
  })
  .strict();
const SourcePatch = z.object(sourceFields).partial().strict();
const SourceListQuery = listQuery([...SOURCE_SORTS.keys()]).extend({
  kind: z.enum(DISCOVERY_SOURCE_KINDS).optional(),
});

const RunSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  roleTargetId: z.string().nullable(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
  stats: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
});

const TokenSpreadSchema = z.object({ median: z.number(), p90: z.number() }).nullable();

/** GET /discovery/cost-figures (#209): see repos/discoveryFigures.ts for each figure. */
const CostFiguresSchema = z.object({
  rank: z.array(
    z.object({
      days: z.number().int(),
      calls: z.number().int(),
      errors: z.number().int(),
      inputTokens: TokenSpreadSchema,
      outputTokens: TokenSpreadSchema,
      avgCostUsd: z.number().nullable(),
      totalCostUsd: z.number(),
    }),
  ),
  sources: z.array(
    z.object({
      sourceId: z.string(),
      kind: z.string(),
      openJobs: z.number().nullable(),
      newPerDay: z.number().nullable(),
      days: z.number().int(),
      rankCallsPerDay: z.number().nullable(),
      costPerDayUsd: z.number().nullable(),
      belowCut: z.number().int(),
      belowCutCostUsd: z.number().nullable(),
    }),
  ),
});

/** How many the user agreed to send, having seen the count and the cost (#215). */
const RankBelowCutBody = z.object({ count: z.number().int().min(1).max(1_000_000) });

/** 409 for a result somebody already decided: here, in another tab, or by a capture. */
function alreadyDecided(result: DiscoveryResultView): HttpError {
  const details = {
    disposition: result.disposition,
    // None when it was dismissed (an old race could leave one on the row), or when the opportunity has
    // since been deleted.
    ...(result.disposition !== 'accepted' || result.opportunityId === null
      ? {}
      : { existingId: result.opportunityId }),
  };
  return result.disposition === 'accepted'
    ? new HttpError(409, 'already_decided', 'This result was already accepted.', details, {
        userFacing: true,
      })
    : new HttpError(409, 'already_decided', 'This result was already dismissed.', details, {
        userFacing: true,
      });
}

/**
 * Decides one pending result: the one path of accept, attach, create anyway and dismiss, single
 * and bulk (https://github.com/bgoleno/opportun/issues/968). The user's lock first, then the read
 * the decision is made on, then everything it writes, so a capture of the same posting, which
 * takes that lock before it looks (lib/captureResolve.ts settleLead), either sees this decision or
 * is seen by it. Not the ingest lock: a run holds it, and Accept should not wait for a run. Lock
 * order: repos/submissionReview.ts submissionScope.
 */
async function decidePending<T>(
  db: Db,
  ctx: UserCtx,
  id: string,
  decide: (tx: Exec, result: DiscoveryResultView) => Promise<T>,
): Promise<T> {
  return await withTransaction(db, async (tx) => {
    await lockScope(tx, `user:${ctx.userId}`);
    const result = await getResult(tx, ctx, id);
    if (result.disposition !== 'pending') throw alreadyDecided(result);
    await racePoint('discovery.decide.locked');
    return await decide(tx, result);
  });
}

/** decidePending for one id of a bulk request: what became of it, never a throw. */
async function decideItem<T extends { item: BulkItemResult; opportunityId?: string }>(
  db: Db,
  ctx: UserCtx,
  id: string,
  decide: (tx: Exec, result: DiscoveryResultView) => Promise<T>,
): Promise<{ item: BulkItemResult; opportunityId?: string }> {
  let found = false;
  try {
    return await decidePending(db, ctx, id, (tx, result) => {
      found = true;
      return decide(tx, result);
    });
  } catch (err) {
    if (err instanceof HttpError) {
      const named = err.details?.existingId;
      const existing = typeof named === 'string' ? { existingId: named } : {};
      if (err.code === 'already_decided' || err.code === 'duplicate') {
        return {
          item: { id, outcome: err.code, ...existing },
          opportunityId: existing.existingId,
        };
      }
      if (err.statusCode === 404 && !found) return { item: { id, outcome: 'not_found' } };
    }
    return {
      item: { id, outcome: 'error', message: err instanceof Error ? err.message : String(err) },
    };
  }
}

export async function discoveryRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  // ---- review queue --------------------------------------------------------

  api.get(
    '/discovery/results',
    { schema: { querystring: ResultListQuery, response: { 200: pageOf(ResultSchema) } } },
    async (req) => await listResults(db, app.requireUser(req), req.query),
  );

  // The pre-filter's recall on what the user accepted (#217): measured, acting on nothing yet.
  api.get(
    '/discovery/prefilter/recall',
    { schema: { response: { 200: PrefilterRecallSchema } } },
    async (req) => await prefilterRecall(db, app.requireUser(req)),
  );

  api.get(
    '/discovery/results/:id',
    { schema: { params: IdParams, response: { 200: ResultSchema } } },
    async (req) => await getResult(db, app.requireUser(req), req.params.id),
  );

  /**
   * The default accept path (no `attachTo`): creates an opportunity from the result's
   * posting and marks the result accepted, UNLESS this very posting was captured already, or its
   * own card (cardKey: one company and one whole title, #968) has an open opportunity, in which
   * case it links to that one instead (issue #226; openOpportunityFor, #971). Shared by the single and
   * bulk accept routes, so a bulk accept runs exactly the same create-or-chain logic as a
   * single one, item by item, rather than a second version of it.
   *
   * This is deliberately not scoped to "another chunk of the same bulk request": chunking is
   * a transport detail (api.ts's bulkRequest splits a selection over MAX_BULK_SIZE), and the
   * route's own grouping already recomputes from stored data rather than trusting the client's
   * view of which ids arrived together, for the same reason (see the comment on the
   * bulk-accept route below). Finding the target this way also fixes the identical gap between
   * two independent, unchunked accepts of the same role minutes or weeks apart -- something no
   * amount of client-side batch bookkeeping would have caught, because it isn't a chunking
   * problem at all, just the same missing memory.
   *
   * `chained` tells the caller which happened, since both still return 200 with an
   * opportunity id attached to the result: `acceptResolving` needs it to report `attached`
   * rather than `accepted` in a bulk response (BulkItemResult's own `accepted`/`attached`
   * split). The chain lookup itself is skipped entirely when `force` is set, since forcing is
   * already an explicit "no, a new one" from the user.
   */
  async function acceptIntoOpportunity(
    tx: Exec,
    ctx: UserCtx,
    result: DiscoveryResultView,
    opts: { force?: boolean } = {},
  ): Promise<{ view: DiscoveryResultView; chained: boolean }> {
    const p = result.posting;
    if (opts.force !== true && result.dedupeKey !== null) {
      const chainTarget = await openOpportunityFor(tx, ctx, p, result.dedupeKey);
      if (chainTarget !== undefined) {
        return { view: await linkTo(tx, ctx, result, chainTarget), chained: true };
      }
    }
    const opp = await createOpportunity(
      tx,
      ctx,
      {
        companyName: p.company,
        title: p.title,
        descriptionMd: p.descriptionMd ?? null,
        postingUrl: httpLink(p.postingUrl),
        location: p.location ?? null,
        remote: p.remote ?? null,
        compNote: p.compNote ?? null,
        roleTargetId: result.roleTargetId,
        sourceKind: 'discovery',
        sourceRef: result.id,
      },
      { force: opts.force === true },
    );
    return { view: await setDisposition(tx, ctx, result.id, 'accepted', opp.id), chained: false };
  }

  /** Another source for a job already tracked: links it, changes nothing else (FR-O10). The
   *  result's row before the timeline entry, whose search row is the last of the lock order. */
  async function linkTo(
    tx: Exec,
    ctx: UserCtx,
    result: DiscoveryResultView,
    opportunityId: string,
  ): Promise<DiscoveryResultView> {
    const view = await setDisposition(tx, ctx, result.id, 'accepted', opportunityId);
    await recordAlsoPosted(tx, ctx, opportunityId, result);
    return view;
  }

  /** Attaches a result to an opportunity the caller names; another user's is the 404 of a missing one. */
  async function attachTo(
    tx: Exec,
    ctx: UserCtx,
    result: DiscoveryResultView,
    opportunityId: string,
  ): Promise<DiscoveryResultView> {
    // Not the result's own 404: the page says which of the two is gone.
    const target = await getOpportunity(tx, ctx, opportunityId).catch((err: unknown) => {
      if (err instanceof HttpError && err.statusCode === 404) {
        throw new HttpError(404, 'opportunity_not_found');
      }
      throw err;
    });
    return await linkTo(tx, ctx, result, target.id);
  }

  /** Dismisses a result, with the feedback row refineDiscoveryPrompt reads its reason from. */
  async function dismiss(
    tx: Exec,
    ctx: UserCtx,
    result: DiscoveryResultView,
    reason: (typeof DISMISS_REASONS)[number] | null,
    note: string | null,
  ): Promise<DiscoveryResultView> {
    await tx
      .insert(dismissalFeedback)
      .values({
        id: newId(),
        userId: ctx.userId,
        kind: 'dismissal',
        resultId: result.id,
        opportunityId: null,
        reason,
        note,
        at: Date.now(),
      })
      .run();
    return await setDisposition(tx, ctx, result.id, 'dismissed');
  }

  /**
   * The shared body of acceptOne and a group's primary accept (issue #209): never passes
   * `force`, so a dedupe conflict is reported, not papered over on the user's behalf (#184).
   * Also returns the opportunity id behind a successful `accepted`, which `BulkItemResult`
   * itself does not carry (its `existingId` field means "already existed", the opposite
   * claim), so a caller chaining the rest of a group onto it does not have to re-fetch the
   * result it just wrote.
   */
  async function acceptResolving(
    ctx: UserCtx,
    id: string,
  ): Promise<{ item: BulkItemResult; opportunityId?: string }> {
    return await decideItem(db, ctx, id, async (tx, result) => {
      const { view, chained } = await acceptIntoOpportunity(tx, ctx, result);
      return {
        item: chained
          ? { id, outcome: 'attached', existingId: view.opportunityId ?? undefined }
          : { id, outcome: 'accepted' },
        opportunityId: view.opportunityId ?? undefined,
      };
    });
  }

  /** One item of a bulk accept, independent of any group (today's whole contract, before
   *  issue #209: each id either creates its own opportunity or reports its own conflict). */
  async function acceptOne(ctx: UserCtx, id: string): Promise<BulkItemResult> {
    return (await acceptResolving(ctx, id)).item;
  }

  /** One non-primary member of a location group (issue #209): attaches to the opportunity
   *  its group's primary produced (created, or already existed per a dedupe conflict) rather
   *  than creating its own, via the same link mechanism the single-item accept route's own
   *  `attachTo` uses (FR-O10). */
  async function attachOne(
    ctx: UserCtx,
    id: string,
    opportunityId: string,
  ): Promise<BulkItemResult> {
    const { item } = await decideItem(db, ctx, id, async (tx, result) => {
      const view = await attachTo(tx, ctx, result, opportunityId);
      return { item: { id, outcome: 'attached', existingId: view.opportunityId ?? undefined } };
    });
    return item;
  }

  /** Whether an opportunity, by its own company and title, is the job of this card. */
  async function isOfCard(ctx: UserCtx, opportunityId: string, card: string): Promise<boolean> {
    const opp = await getOpportunity(db, ctx, opportunityId).catch(() => null);
    if (opp === null) return false;
    const { companyName, title, location } = opp;
    return cardKey(dedupeKey(companyName, title, location), companyName, title) === card;
  }

  /** One item of a bulk dismiss: `not_interested` (bulk's own reason, #184) is written like
   *  any other, just excluded later from refineDiscoveryPrompt's evidence query. */
  async function dismissOne(
    ctx: UserCtx,
    id: string,
    reason: (typeof DISMISS_REASONS)[number],
    note: string | undefined,
  ): Promise<BulkItemResult> {
    const { item } = await decideItem(db, ctx, id, async (tx, result) => {
      await dismiss(tx, ctx, result, reason, note ?? null);
      return { item: { id, outcome: 'dismissed' } };
    });
    return item;
  }

  api.post(
    '/discovery/results/:id/accept',
    { schema: { params: IdParams, body: AcceptBody, response: { 200: ResultSchema } } },
    async (req) => {
      const ctx = app.requireUser(req);
      const { attachTo: target, force } = req.body;
      // A result already decided is a 409 already_decided before either is looked at, naming the
      // opportunity it went to, so `duplicate` means one thing: a pending result matches another
      // opportunity. That is the existing create path's: an exact company+title+location dedupe
      // match, writing nothing, so the result stays pending. A same-role, different-location (or
      // identical) match with its own already-accepted, still-eligible opportunity chains to it
      // instead (issue #226) and a `force` skips that lookup entirely.
      return await decidePending(db, ctx, req.params.id, async (tx, result) =>
        target === undefined
          ? (await acceptIntoOpportunity(tx, ctx, result, { force: force === true })).view
          : await attachTo(tx, ctx, result, target),
      );
    },
  );

  api.post(
    '/discovery/results/bulk-accept',
    { schema: { body: BulkIdsBody, response: { 200: BulkResultSchema } } },
    async (req) => {
      const ctx = app.requireUser(req);

      // Full location groups among the requested ids (issue #209): the same role in several
      // locations must become one opportunity, not N. Detected server-side from each result's
      // own stored dedupeKey, never trusted from the client, because the client's own view of
      // grouping is necessarily incomplete past whatever page it has loaded -- recomputing
      // here is what makes this correct for a "select all N matching" selection too, not just
      // a selection built from checkboxes on loaded rows.
      //
      // This grouping is only ever within THIS request's own ids. A selection over
      // MAX_BULK_SIZE is split by the client (api.ts's bulkRequest) into separate sequential
      // requests with no memory of each other, so a group split across that chunk boundary
      // used to still produce more than one opportunity (issue #226) even though this code
      // grouped correctly within each chunk. Fixed not here but one level down, in
      // acceptIntoOpportunity: a would-be primary (this loop's `primary`, or a true singleton
      // falling through to `acceptOne` below) first asks whether its own card already has
      // an eligible opportunity from an earlier accept -- another chunk, or any other earlier
      // accept of the same role -- and chains to it instead of creating. That makes the chunk
      // boundary irrelevant here rather than something this route has to reason about.
      const fetched = await Promise.all(
        req.body.ids.map(async (id) => {
          try {
            return { id, result: await getResult(db, ctx, id) };
          } catch (err) {
            if (err instanceof HttpError && err.statusCode === 404)
              return { id, result: undefined };
            throw err;
          }
        }),
      );
      const byGroupKey = new Map<string, { id: string; result: DiscoveryResultView }[]>();
      for (const f of fetched) {
        if (f.result === undefined || f.result.disposition !== 'pending') continue;
        const { dedupeKey: stored, posting } = f.result;
        const key = stored === null ? `#${f.id}` : cardKey(stored, posting.company, posting.title);
        const existing = byGroupKey.get(key);
        if (existing === undefined) byGroupKey.set(key, [{ id: f.id, result: f.result }]);
        else existing.push({ id: f.id, result: f.result });
      }

      const results: BulkItemResult[] = [];
      const handled = new Set<string>();
      for (const [card, members] of byGroupKey) {
        // A singleton "group" (including the `#${id}` fallback for a keyless result) is just
        // an ordinary id: falls through to the independent accept loop below, unchanged from
        // today.
        if (members.length < 2) continue;
        // Best AI score first, matching the queue's own ordering (listResults' default sort
        // and fetchAllPendingResultIds' query): the member most likely to be the role the
        // user actually meant becomes the one opportunity the rest attach to.
        const sorted = [...members].sort(
          (a, b) => (b.result.aiScore ?? -Infinity) - (a.result.aiScore ?? -Infinity),
        );
        const primary = sorted[0]!;
        handled.add(primary.id);
        const { item, opportunityId } = await acceptResolving(ctx, primary.id);
        results.push(item);
        // A duplicate names the holder of the primary's key, which strips levels, so it can be another
        // level's job: the rest follow only into one of their own card, and are accepted on their own
        // otherwise.
        if (
          item.outcome === 'duplicate' &&
          opportunityId !== undefined &&
          !(await isOfCard(ctx, opportunityId, card))
        ) {
          for (const member of sorted.slice(1)) {
            handled.add(member.id);
            results.push(await acceptOne(ctx, member.id));
          }
          continue;
        }
        for (const member of sorted.slice(1)) {
          handled.add(member.id);
          results.push(
            opportunityId === undefined
              ? {
                  id: member.id,
                  outcome: 'error',
                  message: "the group's primary accept did not produce an opportunity to attach to",
                }
              : await attachOne(ctx, member.id, opportunityId),
          );
        }
      }
      for (const id of req.body.ids) {
        if (!handled.has(id)) results.push(await acceptOne(ctx, id));
      }

      // The caller's own id order, not the group-then-singleton order processed above.
      const byId = new Map(results.map((r) => [r.id, r]));
      return { results: req.body.ids.map((id) => byId.get(id)!) };
    },
  );

  api.post(
    '/discovery/results/:id/dismiss',
    { schema: { params: IdParams, body: DismissBody, response: { 200: ResultSchema } } },
    async (req) => {
      const ctx = app.requireUser(req);
      return await decidePending(db, ctx, req.params.id, (tx, result) =>
        dismiss(tx, ctx, result, req.body.reason ?? null, req.body.note ?? null),
      );
    },
  );

  api.post(
    '/discovery/results/bulk-dismiss',
    { schema: { body: BulkDismissBody, response: { 200: BulkResultSchema } } },
    async (req) => {
      const ctx = app.requireUser(req);
      const results: BulkItemResult[] = [];
      for (const id of req.body.ids) {
        results.push(await dismissOne(ctx, id, req.body.reason, req.body.note));
      }
      return { results };
    },
  );

  /**
   * Undoes a bulk dismiss (#184): one action for the whole batch, offered from the toast, not
   * a trip through the Decided tab per item. Reverts exactly the ids given, and only the ones
   * still `dismissed` from that batch; an id already moved on by something else (unsuppressed,
   * re-dismissed, accepted after the fact) is left alone and reported, not forced back. Also
   * removes the dismissal_feedback rows the dismiss wrote, so an undone decision leaves no
   * trace in refineDiscoveryPrompt's evidence: the user said "that didn't happen", not "that
   * happened but for a reason I'm hiding."
   */
  api.post(
    '/discovery/results/bulk-undo-dismiss',
    { schema: { body: BulkIdsBody, response: { 200: BulkResultSchema } } },
    async (req) => {
      const ctx = app.requireUser(req);
      const results: BulkItemResult[] = [];
      for (const id of req.body.ids) {
        results.push(
          await withTransaction(db, async (tx) => {
            // As decidePending: an Accept between this read and its write would be undone with it.
            await lockScope(tx, `user:${ctx.userId}`);
            let result: DiscoveryResultView;
            try {
              result = await getResult(tx, ctx, id);
            } catch (err) {
              if (err instanceof HttpError && err.statusCode === 404) {
                return { id, outcome: 'not_found' as const };
              }
              throw err;
            }
            if (result.disposition !== 'dismissed')
              return { id, outcome: 'already_decided' as const };
            await racePoint('discovery.undo.locked');
            await tx
              .delete(dismissalFeedback)
              .where(
                and(eq(dismissalFeedback.userId, ctx.userId), eq(dismissalFeedback.resultId, id)),
              )
              .run();
            await setDisposition(tx, ctx, id, 'pending');
            return { id, outcome: 'restored' as const };
          }),
        );
      }
      await resumeAfterUndo(
        db,
        ctx,
        results.filter((r) => r.outcome === 'restored').map((r) => r.id),
      );
      return { results };
    },
  );

  /**
   * Lifts this decided result's permanent repost suppression (#11): a later posting with the
   * same dedupe key is evaluated fresh instead of treated as a duplicate forever. Leaves the
   * result's own disposition, score and dismissal feedback untouched; nothing else changes
   * unless the caller acts on it, and no other result is affected.
   */
  api.post(
    '/discovery/results/:id/unsuppress',
    { schema: { params: IdParams, response: { 200: ResultSchema } } },
    async (req) => await unsuppressResult(db, app.requireUser(req), req.params.id),
  );

  // ---- merge ---------------------------------------------------------------

  api.post(
    '/opportunities/:id/merge',
    { schema: { params: IdParams, body: MergeBody, response: { 200: OpportunityView } } },
    async (req) =>
      await mergeOpportunities(db, app.requireUser(req), req.params.id, req.body.otherId),
  );

  // ---- sources -------------------------------------------------------------

  // Ranking cost and each board's posting volume (#209): read-only, the caller's own records.
  api.get(
    '/discovery/cost-figures',
    { schema: { response: { 200: CostFiguresSchema } } },
    async (req) => await discoveryCostFigures(db, app.requireUser(req)),
  );

  api.get(
    '/discovery/sources',
    { schema: { querystring: SourceListQuery, response: { 200: pageOf(SourceSchema) } } },
    async (req) => await listSources(db, app.requireUser(req), req.query),
  );

  api.post(
    '/discovery/sources',
    { schema: { body: SourceCreate, response: { 201: SourceSchema } } },
    async (req, reply) =>
      reply
        .code(201)
        .send(await createSource(db, app.requireUser(req), req.body, { demo: app.config.demo })),
  );

  api.get(
    '/discovery/sources/:id',
    { schema: { params: IdParams, response: { 200: SourceSchema } } },
    async (req) => await getSourceRow(db, app.requireUser(req), req.params.id),
  );

  api.patch(
    '/discovery/sources/:id',
    { schema: { params: IdParams, body: SourcePatch, response: { 200: SourceSchema } } },
    async (req) =>
      await updateSource(db, app.requireUser(req), req.params.id, req.body, {
        demo: app.config.demo,
      }),
  );

  api.delete(
    '/discovery/sources/:id',
    { schema: { params: IdParams, response: { 204: z.null() } } },
    async (req, reply) => {
      await deleteSource(db, app.requireUser(req), req.params.id);
      return reply.code(204).send(null);
    },
  );

  /**
   * Run now: queues a run (deduped while one is unfinished), whatever the schedule says. A
   * disabled source is refused with 409 source_disabled (#297), and so is one with a run in
   * progress, with 409 run_in_progress (#269): a second run would read the board again at the same
   * time, and the 202 would tell the user nothing.
   */
  api.post(
    '/discovery/sources/:id/run',
    { schema: { params: IdParams, response: { 202: z.object({ jobId: z.string() }) } } },
    async (req, reply) => {
      const ctx = app.requireUser(req);
      const source = await getSourceRow(db, ctx, req.params.id);
      // Channels that deliver postings themselves (alert_email, manual, extension) have no adapter.
      if (!hasSource(source.kind)) throw new HttpError(422, 'source_not_runnable');
      // A run skips a disabled source, so queueing one would answer 202 and then do nothing (#297).
      // Refuse instead of enabling it: turning a source on is the user's own decision.
      if (!source.enabled) throw new HttpError(409, 'source_disabled');
      // A run that starts after this check still finds this one going, and records a Skipped run
      // instead of reading the board (jobs/discoveryRun.ts runDiscoverySource).
      if (await hasRunInProgress(db, ctx, source.id)) throw new HttpError(409, 'run_in_progress');
      const jobId = await enqueue(
        db,
        DISCOVERY_RUN_KIND,
        { sourceId: source.id },
        { dedupeKey: `${DISCOVERY_RUN_KIND}:now:${source.id}`, userId: ctx.userId },
      );
      return reply.code(202).send({ jobId });
    },
  );

  /**
   * Rank these (#215): sends this source's postings below the first-run cut through the budget, and
   * no more than the count the user confirmed: a retry of a failing first run can add to them while
   * the dialog is open. A stale count sends the newest that many, and the rest stay for next time.
   */
  api.post(
    '/discovery/sources/:id/rank-below-cut',
    {
      schema: {
        params: IdParams,
        body: RankBelowCutBody,
        response: { 202: z.object({ queued: z.number().int() }) },
      },
    },
    async (req, reply) => {
      const ctx = app.requireUser(req);
      const source = await getSourceRow(db, ctx, req.params.id);
      const queued = await rankBelowCut(db, ctx, source.id, req.body.count);
      return reply.code(202).send({ queued });
    },
  );

  // Rank anyway (#218): one the pre-filter held. 404 for anything but the caller's own.
  api.post(
    '/discovery/results/:id/rank-anyway',
    {
      schema: {
        params: IdParams,
        response: { 202: z.object({ queued: z.number().int() }) },
      },
    },
    async (req, reply) => {
      const queued = await rankAnyway(db, app.requireUser(req), req.params.id);
      return reply.code(202).send({ queued });
    },
  );

  api.get(
    '/discovery/sources/:id/runs',
    {
      schema: {
        params: IdParams,
        querystring: listQuery([...RUN_SORTS.keys()]),
        response: { 200: pageOf(RunSchema) },
      },
    },
    async (req) => {
      const ctx = app.requireUser(req);
      const source = await getSourceRow(db, ctx, req.params.id);
      return await listRuns(db, ctx, source.id, req.query);
    },
  );
}
