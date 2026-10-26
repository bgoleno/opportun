// Discovery API (FR-D1, D3, FR-O7, FR-O10): the review queue (list, accept or attach, dismiss),
// opportunity merge, and the user's discovery sources (CRUD, run now, run history).
import {
  dedupeGroupKey,
  DISCOVERY_SOURCE_KINDS,
  DISMISS_REASONS,
  DISPOSITIONS,
  newId,
  NormalizedPostingSchema,
  RESOLUTIONS,
} from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { hasSource } from '../adapters/discoverySource';
import { DISCOVERY_RUN_KIND } from '../jobs/discoveryKinds';
import { enqueue } from '../jobs/runner';
import { HttpError, duplicate } from '../lib/errors';
import { createActivity } from '../repos/activities';
import {
  createSource,
  deleteSource,
  findChainTarget,
  getResult,
  getSourceRow,
  listResults,
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
import { sourceLabel } from '../lib/sourceLabels';
import { IdParams, listQuery, optionalText, pageOf } from './common';
import { OpportunityView } from './opportunities';
import { withTransaction } from '../db/client';
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
  /** Present only for `duplicate` and `attached`: the opportunity this id already matches,
   *  or was linked to. */
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
  scheduleCron: optionalText(100),
  roleTargetId: z.string().min(1).max(64).nullable(),
  companyId: z.string().min(1).max(64).nullable(),
};
const SourceCreate = z
  .object({ kind: z.enum(DISCOVERY_SOURCE_KINDS), ...sourceFields })
  .partial({ config: true, enabled: true, scheduleCron: true, roleTargetId: true, companyId: true })
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

/** A short, link-safe label for a source kind in activity titles. */
function httpLink(url: string | null | undefined): string | null {
  if (url == null) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
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

  api.get(
    '/discovery/results/:id',
    { schema: { params: IdParams, response: { 200: ResultSchema } } },
    async (req) => await getResult(db, app.requireUser(req), req.params.id),
  );

  /**
   * The default accept path (no `attachTo`): creates an opportunity from the result's
   * posting and marks the result accepted, UNLESS this result's own role (issue #209's
   * company+title group key) already has a live, still-eligible opportunity from an earlier
   * accept, in which case it links to that one instead (issue #226). Shared by the single and
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
    ctx: UserCtx,
    result: DiscoveryResultView,
    opts: { force?: boolean } = {},
  ): Promise<{ view: DiscoveryResultView; chained: boolean }> {
    const p = result.posting;
    if (opts.force !== true && result.dedupeKey !== null) {
      const chainTarget = await findChainTarget(db, ctx, dedupeGroupKey(result.dedupeKey));
      if (chainTarget !== undefined) {
        await createActivity(db, ctx, chainTarget, {
          kind: 'link',
          title: `Also posted via ${sourceLabel(result.sourceKind)}`,
          bodyMd: [`${p.company}: ${p.title}`, p.location ?? null]
            .filter((l): l is string => l !== null)
            .join('\n'),
          occurredAt: Date.now(),
          participants: [],
          externalUrl: httpLink(p.postingUrl),
        });
        return {
          view: await setDisposition(db, ctx, result.id, 'accepted', chainTarget),
          chained: true,
        };
      }
    }
    const opp = await createOpportunity(
      db,
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
    return { view: await setDisposition(db, ctx, result.id, 'accepted', opp.id), chained: false };
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
    let result: DiscoveryResultView;
    try {
      result = await getResult(db, ctx, id);
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 404)
        return { item: { id, outcome: 'not_found' } };
      throw err;
    }
    if (result.disposition === 'accepted') {
      return {
        item:
          result.opportunityId !== null
            ? { id, outcome: 'duplicate', existingId: result.opportunityId }
            : { id, outcome: 'already_decided' },
        opportunityId: result.opportunityId ?? undefined,
      };
    }
    if (result.disposition !== 'pending') return { item: { id, outcome: 'already_decided' } };
    try {
      const { view, chained } = await acceptIntoOpportunity(ctx, result);
      return {
        item: chained
          ? { id, outcome: 'attached', existingId: view.opportunityId ?? undefined }
          : { id, outcome: 'accepted' },
        opportunityId: view.opportunityId ?? undefined,
      };
    } catch (err) {
      if (err instanceof HttpError && err.code === 'duplicate') {
        const existingId = err.details?.existingId;
        const existing = typeof existingId === 'string' ? existingId : undefined;
        return {
          item: { id, outcome: 'duplicate', existingId: existing },
          opportunityId: existing,
        };
      }
      return {
        item: { id, outcome: 'error', message: err instanceof Error ? err.message : String(err) },
      };
    }
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
    let result: DiscoveryResultView;
    try {
      result = await getResult(db, ctx, id);
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 404) return { id, outcome: 'not_found' };
      throw err;
    }
    if (result.disposition === 'accepted') {
      return result.opportunityId !== null
        ? { id, outcome: 'duplicate', existingId: result.opportunityId }
        : { id, outcome: 'already_decided' };
    }
    if (result.disposition !== 'pending') return { id, outcome: 'already_decided' };
    try {
      const p = result.posting;
      const target = await getOpportunity(db, ctx, opportunityId);
      await createActivity(db, ctx, target.id, {
        kind: 'link',
        title: `Also posted via ${sourceLabel(result.sourceKind)}`,
        bodyMd: [`${p.company}: ${p.title}`, p.location ?? null]
          .filter((l): l is string => l !== null)
          .join('\n'),
        occurredAt: Date.now(),
        participants: [],
        externalUrl: httpLink(p.postingUrl),
      });
      await setDisposition(db, ctx, result.id, 'accepted', target.id);
      return { id, outcome: 'attached', existingId: target.id };
    } catch (err) {
      if (err instanceof HttpError && err.code === 'duplicate') {
        const existingId = err.details?.existingId;
        return {
          id,
          outcome: 'duplicate',
          existingId: typeof existingId === 'string' ? existingId : undefined,
        };
      }
      return { id, outcome: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** One item of a bulk dismiss: `not_interested` (bulk's own reason, #184) is written like
   *  any other, just excluded later from refineDiscoveryPrompt's evidence query. */
  async function dismissOne(
    ctx: UserCtx,
    id: string,
    reason: (typeof DISMISS_REASONS)[number],
    note: string | undefined,
  ): Promise<BulkItemResult> {
    try {
      return await withTransaction(db, async (tx) => {
        const result = await getResult(tx, ctx, id);
        if (result.disposition !== 'pending') return { id, outcome: 'already_decided' as const };
        await tx
          .insert(dismissalFeedback)
          .values({
            id: newId(),
            userId: ctx.userId,
            kind: 'dismissal',
            resultId: result.id,
            opportunityId: null,
            reason,
            note: note ?? null,
            at: Date.now(),
          })
          .run();
        await setDisposition(tx, ctx, result.id, 'dismissed');
        return { id, outcome: 'dismissed' as const };
      });
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 404) return { id, outcome: 'not_found' };
      return { id, outcome: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  api.post(
    '/discovery/results/:id/accept',
    { schema: { params: IdParams, body: AcceptBody, response: { 200: ResultSchema } } },
    async (req) => {
      const ctx = app.requireUser(req);
      const result = await getResult(db, ctx, req.params.id);
      if (result.disposition === 'accepted') {
        if (result.opportunityId !== null) throw duplicate(result.opportunityId);
        throw new HttpError(409, 'already_accepted');
      }
      const p = result.posting;
      if (req.body.attachTo !== undefined) {
        // Another source for a job already tracked: link it, change nothing else (FR-O10).
        const target = await getOpportunity(db, ctx, req.body.attachTo);
        await createActivity(db, ctx, target.id, {
          kind: 'link',
          title: `Also posted via ${sourceLabel(result.sourceKind)}`,
          bodyMd: [`${p.company}: ${p.title}`, p.location ?? null]
            .filter((l): l is string => l !== null)
            .join('\n'),
          occurredAt: Date.now(),
          participants: [],
          externalUrl: httpLink(p.postingUrl),
        });
        return await setDisposition(db, ctx, result.id, 'accepted', target.id);
      }
      // The existing create path: an exact company+title+location dedupe match is still a 409
      // naming the existing opportunity, writing nothing, so the result stays pending. A
      // same-role, different-location (or identical) match with its own already-accepted,
      // still-eligible opportunity chains to it instead (issue #226) and a `force` skips that
      // lookup entirely.
      return (await acceptIntoOpportunity(ctx, result, { force: req.body.force === true })).view;
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
      // falling through to `acceptOne` below) first asks whether its own group key already has
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
        const key = f.result.dedupeKey === null ? `#${f.id}` : dedupeGroupKey(f.result.dedupeKey);
        const existing = byGroupKey.get(key);
        if (existing === undefined) byGroupKey.set(key, [{ id: f.id, result: f.result }]);
        else existing.push({ id: f.id, result: f.result });
      }

      const results: BulkItemResult[] = [];
      const handled = new Set<string>();
      for (const members of byGroupKey.values()) {
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
      return await withTransaction(db, async (tx) => {
        const result = await getResult(tx, ctx, req.params.id);
        if (result.disposition !== 'pending') throw new HttpError(409, 'not_pending');
        await tx
          .insert(dismissalFeedback)
          .values({
            id: newId(),
            userId: ctx.userId,
            kind: 'dismissal',
            resultId: result.id,
            opportunityId: null,
            reason: req.body.reason ?? null,
            note: req.body.note ?? null,
            at: Date.now(),
          })
          .run();
        return await setDisposition(tx, ctx, result.id, 'dismissed');
      });
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

  api.get(
    '/discovery/sources',
    { schema: { querystring: SourceListQuery, response: { 200: pageOf(SourceSchema) } } },
    async (req) => await listSources(db, app.requireUser(req), req.query),
  );

  api.post(
    '/discovery/sources',
    { schema: { body: SourceCreate, response: { 201: SourceSchema } } },
    async (req, reply) =>
      reply.code(201).send(await createSource(db, app.requireUser(req), req.body)),
  );

  api.get(
    '/discovery/sources/:id',
    { schema: { params: IdParams, response: { 200: SourceSchema } } },
    async (req) => await getSourceRow(db, app.requireUser(req), req.params.id),
  );

  api.patch(
    '/discovery/sources/:id',
    { schema: { params: IdParams, body: SourcePatch, response: { 200: SourceSchema } } },
    async (req) => await updateSource(db, app.requireUser(req), req.params.id, req.body),
  );

  api.delete(
    '/discovery/sources/:id',
    { schema: { params: IdParams, response: { 204: z.null() } } },
    async (req, reply) => {
      await deleteSource(db, app.requireUser(req), req.params.id);
      return reply.code(204).send(null);
    },
  );

  /** Run now: queues a run (deduped while one is unfinished), whatever the schedule says. */
  api.post(
    '/discovery/sources/:id/run',
    { schema: { params: IdParams, response: { 202: z.object({ jobId: z.string() }) } } },
    async (req, reply) => {
      const ctx = app.requireUser(req);
      const source = await getSourceRow(db, ctx, req.params.id);
      // Channels that deliver postings themselves (alert_email, manual, extension) have no adapter.
      if (!hasSource(source.kind)) throw new HttpError(422, 'source_not_runnable');
      const jobId = await enqueue(
        db,
        DISCOVERY_RUN_KIND,
        { sourceId: source.id },
        { dedupeKey: `${DISCOVERY_RUN_KIND}:now:${source.id}`, userId: ctx.userId },
      );
      return reply.code(202).send({ jobId });
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
