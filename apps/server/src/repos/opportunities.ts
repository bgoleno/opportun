// Opportunities and their lifecycle (FR-O1, O2, O5). Stage changes go through
// applyTransition from @opportun/core and write opportunities + stage_history in one
// transaction, so a rejected transition writes nothing.
import { and, count, eq, getTableColumns, inArray, max, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  ACTIVE_PIPELINE_STAGES,
  applyTransition,
  dedupeKey,
  InvalidTransitionError,
  newId,
  OPPORTUNITY_STAGES,
  type AtsJobRef,
  type ClosedReason,
  type DismissReason,
  type OpportunityStage,
  type PostingState,
  type PostingStateDetail,
  type SourceKind,
} from '@opportun/core';
import { enqueueCompanyDomainResolve } from '../jobs/companyDomainResolve';
import {
  activities,
  attachments,
  communications,
  companies,
  discoveryResults,
  dismissalFeedback,
  nextSteps,
  opportunities,
  resumes,
  roleTargets,
  stageHistory,
} from '../db/schema';
import { duplicate, HttpError, notFound } from '../lib/errors';
import { isSystemWritten } from '../lib/postingFingerprint';
import type { Db, Exec, UserCtx } from './base';
import { findOrCreateCompanySync } from './companies';
import { detectDedupeCandidates, rejectDedupeCandidate } from './opportunityDedupe';
import { likeContains, orderBy, sortColumns, type ListOpts, type Page } from './list';
import {
  indexActivity,
  indexOpportunity,
  removeFromIndex,
  removeOpportunityFromIndex,
} from './search';
import { runCount, withTransaction } from '../db/client';

export type OpportunityRow = typeof opportunities.$inferSelect;
/**
 * An opportunity as the API returns it: the row plus its company's name and the ids of any
 * opportunity it is flagged as a possible duplicate with, from either direction (#9). The raw
 * `possibleDuplicateOf` column is one-directional and not exposed itself; see
 * reverseDuplicatesOf.
 */
export type OpportunityView = OpportunityRow & {
  companyName: string;
  /** Null until a homepage is confidently resolved (issue #239); never a guess. */
  companyDomain: string | null;
  possibleDuplicates: string[];
  /** Issue #255: true when the description is the user's own writing. */
  descriptionIsUserWritten: boolean;
  /** Issue #264: true when a 'capture' activity exists on this opportunity's timeline, so the
   *  client knows whether re-deriving a description from it is even possible. */
  hasCapturedPage: boolean;
};

export interface CreateOpportunityInput {
  companyName: string;
  title: string;
  descriptionMd?: string | null | undefined;
  postingUrl?: string | null | undefined;
  sourceKind: SourceKind;
  location?: string | null | undefined;
  remote?: boolean | null | undefined;
  compNote?: string | null | undefined;
  roleTargetId?: string | null | undefined;
  priority?: number | undefined;
  /** Where it came from, e.g. the discovery result id for an accepted result. */
  sourceRef?: string | null | undefined;
}

export type UpdateOpportunityInput = Partial<
  Omit<CreateOpportunityInput, 'sourceKind' | 'priority' | 'sourceRef'> & {
    priority: number;
    stageDetail: string | null;
    /** Manual position within a stage (issue #240): a drag reorder sets this directly. */
    sortOrder: number;
    /**
     * SHA-256 of the description being written, so a later board merge can tell its own
     * writing from the user's (design D11). Internal only: the PATCH route builds its body
     * from an explicit field list, so this is not reachable from the API.
     */
    descriptionFingerprint: string | null;
  }
>;

export interface StageChange {
  to: OpportunityStage;
  closedReason?: ClosedReason | undefined;
  dismissedReason?: DismissReason | undefined;
  note?: string | undefined;
  /** Required to leave a terminal stage (closed/dismissed) for a chain stage. */
  reopen?: boolean | undefined;
}

const TERMINAL: ReadonlySet<OpportunityStage> = new Set(['dismissed', 'closed']);

/**
 * Appends to the bottom of a stage's manual order (issue #240): one past the highest
 * `sortOrder` already in that stage for this user, or 0 for the first card in it. Used both
 * for a brand-new opportunity and for one arriving in a stage via a stage change -- a card
 * never inherits a rank from wherever it came from.
 */
async function nextSortOrder(exec: Exec, ctx: UserCtx, stage: OpportunityStage): Promise<number> {
  const row = await exec
    .select({ max: max(opportunities.sortOrder) })
    .from(opportunities)
    .where(and(eq(opportunities.userId, ctx.userId), eq(opportunities.stage, stage)))
    .get();
  return row?.max === null || row?.max === undefined ? 0 : row.max + 10;
}

/**
 * Orders stages by lifecycle position rather than alphabetically. The positions are inline
 * integer literals: bound parameters would be typed text on Postgres and sort as strings
 * ('10' before '2').
 */
const STAGE_ORDER = sql`CASE ${opportunities.stage} ${sql.join(
  OPPORTUNITY_STAGES.map((s, i) => sql`WHEN ${s} THEN ${sql.raw(String(i))}`),
  sql` `,
)} END`;

export const OPPORTUNITY_SORTS = sortColumns({
  title: opportunities.title,
  companyName: companies.name,
  stage: STAGE_ORDER,
  priority: opportunities.priority,
  sortOrder: opportunities.sortOrder,
  createdAt: opportunities.createdAt,
  updatedAt: opportunities.updatedAt,
});

const viewColumns = {
  ...getTableColumns(opportunities),
  companyName: companies.name,
  companyDomain: companies.domain,
};

function selectView(exec: Exec) {
  return exec
    .select(viewColumns)
    .from(opportunities)
    .innerJoin(companies, eq(companies.id, opportunities.companyId));
}

function owned(ctx: UserCtx, id: string): SQL | undefined {
  return and(eq(opportunities.userId, ctx.userId), eq(opportunities.id, id));
}

/**
 * Every other opportunity (this user's) whose possibleDuplicateOf points at one of `ids`,
 * grouped by the id it points at: the reverse half of the relationship (#9). The column itself
 * is one-directional (the override names what it overrode), so the row it names would
 * otherwise show no badge at all.
 */
async function reverseDuplicatesOf(
  exec: Exec,
  ctx: UserCtx,
  ids: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const rows = await exec
    .select({ id: opportunities.id, possibleDuplicateOf: opportunities.possibleDuplicateOf })
    .from(opportunities)
    .where(
      and(eq(opportunities.userId, ctx.userId), inArray(opportunities.possibleDuplicateOf, ids)),
    )
    .all();
  for (const row of rows) {
    if (row.possibleDuplicateOf === null) continue;
    out.set(row.possibleDuplicateOf, [...(out.get(row.possibleDuplicateOf) ?? []), row.id]);
  }
  return out;
}

/**
 * A view-only derived field (issue #255): true when the stored description is the user's own
 * writing rather than the system's. Refetch's confirmation warning depends on this, and the
 * raw `descriptionFingerprint` it's computed from stays internal -- exposing the hash itself
 * would invite a client to start reasoning about it instead of just asking the one question
 * that matters.
 */
function withDescriptionAuthorship<
  T extends { descriptionMd: string | null; descriptionFingerprint: string | null },
>(row: T): T & { descriptionIsUserWritten: boolean } {
  return {
    ...row,
    descriptionIsUserWritten: !isSystemWritten(row.descriptionMd, row.descriptionFingerprint),
  };
}

/**
 * Ids (of `ids`) that own at least one 'capture' activity, batched the same way
 * reverseDuplicatesOf is: one query for a whole page of rows rather than one per row.
 */
async function capturedOpportunityIds(
  exec: Exec,
  ctx: UserCtx,
  ids: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (ids.length === 0) return out;
  const rows = await exec
    .selectDistinct({ opportunityId: activities.opportunityId })
    .from(activities)
    .where(
      and(
        eq(activities.userId, ctx.userId),
        inArray(activities.opportunityId, ids),
        eq(activities.kind, 'capture'),
      ),
    )
    .all();
  for (const row of rows) out.add(row.opportunityId);
  return out;
}

/**
 * A view-only derived field (issue #264): true when the opportunity has a stored capture to
 * re-derive a description from.
 */
function withHasCapturedPage<T extends { id: string }>(
  row: T,
  captured: Set<string>,
): T & { hasCapturedPage: boolean } {
  return { ...row, hasCapturedPage: captured.has(row.id) };
}

function withPossibleDuplicates<T extends { id: string; possibleDuplicateOf: string | null }>(
  row: T,
  reverse: Map<string, string[]>,
): T & { possibleDuplicates: string[] } {
  return {
    ...row,
    possibleDuplicates: [
      ...(row.possibleDuplicateOf === null ? [] : [row.possibleDuplicateOf]),
      ...(reverse.get(row.id) ?? []),
    ],
  };
}

async function getViewSync(exec: Exec, ctx: UserCtx, id: string): Promise<OpportunityView> {
  const row = await selectView(exec).where(owned(ctx, id)).get();
  if (row === undefined) throw notFound();
  return withDescriptionAuthorship(
    withHasCapturedPage(
      withPossibleDuplicates(row, await reverseDuplicatesOf(exec, ctx, [id])),
      await capturedOpportunityIds(exec, ctx, [id]),
    ),
  );
}

async function assertRoleTargetOwned(
  exec: Exec,
  ctx: UserCtx,
  roleTargetId: string,
): Promise<void> {
  const row = await exec
    .select({ id: roleTargets.id })
    .from(roleTargets)
    .where(and(eq(roleTargets.userId, ctx.userId), eq(roleTargets.id, roleTargetId)))
    .get();
  if (row === undefined) throw notFound();
}

/**
 * Claims `key` for opportunity `selfId` (or a new row). A live holder is a 409 duplicate;
 * a dismissed holder gives the key up so the new live row is the one future dedupe sees.
 */
async function claimDedupeKey(
  exec: Exec,
  ctx: UserCtx,
  key: string,
  selfId: string | null,
): Promise<void> {
  const holder = await exec
    .select({ id: opportunities.id, stage: opportunities.stage })
    .from(opportunities)
    .where(
      and(
        eq(opportunities.userId, ctx.userId),
        eq(opportunities.dedupeKey, key),
        selfId === null ? undefined : ne(opportunities.id, selfId),
      ),
    )
    .get();
  if (holder === undefined) return;
  if (holder.stage !== 'dismissed') throw duplicate(holder.id);
  await exec
    .update(opportunities)
    .set({ dedupeKey: null })
    .where(and(eq(opportunities.userId, ctx.userId), eq(opportunities.id, holder.id)))
    .run();
}

/** The id of the live (non-dismissed) opportunity currently holding `key`, if any. */
async function liveDuplicateId(exec: Exec, ctx: UserCtx, key: string): Promise<string | undefined> {
  const holder = await exec
    .select({ id: opportunities.id, stage: opportunities.stage })
    .from(opportunities)
    .where(and(eq(opportunities.userId, ctx.userId), eq(opportunities.dedupeKey, key)))
    .get();
  return holder !== undefined && holder.stage !== 'dismissed' ? holder.id : undefined;
}

export async function getOpportunity(db: Db, ctx: UserCtx, id: string): Promise<OpportunityView> {
  return await getViewSync(db, ctx, id);
}

export interface OpportunityFilters {
  stage?: OpportunityStage[] | undefined;
  companyId?: string | undefined;
  q?: string | undefined;
}

export async function listOpportunities(
  db: Db,
  ctx: UserCtx,
  opts: ListOpts & OpportunityFilters,
): Promise<Page<OpportunityView>> {
  const where = and(
    eq(opportunities.userId, ctx.userId),
    opts.stage === undefined ? undefined : inArray(opportunities.stage, opts.stage),
    opts.companyId === undefined ? undefined : eq(opportunities.companyId, opts.companyId),
    opts.q === undefined
      ? undefined
      : or(likeContains(opportunities.title, opts.q), likeContains(companies.name, opts.q)),
  );
  const rows = await selectView(db)
    .where(where)
    .orderBy(...orderBy(opts.sort, '-updatedAt', OPPORTUNITY_SORTS, opportunities.id))
    .limit(opts.limit)
    .offset(opts.offset)
    .all();
  const ids = rows.map((r) => r.id);
  const reverse = await reverseDuplicatesOf(db, ctx, ids);
  const captured = await capturedOpportunityIds(db, ctx, ids);
  const items = rows.map((r) =>
    withDescriptionAuthorship(withHasCapturedPage(withPossibleDuplicates(r, reverse), captured)),
  );
  const total =
    (
      await db
        .select({ n: count() })
        .from(opportunities)
        .innerJoin(companies, eq(companies.id, opportunities.companyId))
        .where(where)
        .get()
    )?.n ?? 0;
  return { items, total };
}

/**
 * Creates an opportunity in stage `discovered` with its initial stage_history row.
 * A dedupe key held by a live (non-dismissed) opportunity is a 409 duplicate unless
 * `force`, in which case the new row is stored with a NULL dedupe key and so sits outside
 * future dedupe matching. The overridden opportunity's id is kept as possibleDuplicateOf
 * (#9): it is known for certain at exactly this instant, and the unique dedupe index
 * guarantees dedupeKey equality can never recover it later.
 */
export async function createOpportunity(
  db: Db,
  ctx: UserCtx,
  input: CreateOpportunityInput,
  opts: { force?: boolean } = {},
): Promise<OpportunityView> {
  return await withTransaction(db, async (tx) => {
    if (input.roleTargetId != null) await assertRoleTargetOwned(tx, ctx, input.roleTargetId);
    const key = dedupeKey(input.companyName, input.title, input.location);
    let storedKey: string | null = key;
    let possibleDuplicateOf: string | null = null;
    const liveDup = opts.force === true ? await liveDuplicateId(tx, ctx, key) : undefined;
    if (liveDup !== undefined) {
      storedKey = null;
      possibleDuplicateOf = liveDup;
    } else {
      await claimDedupeKey(tx, ctx, key, null);
    }
    const company = await findOrCreateCompanySync(tx, ctx, input.companyName);
    const sortOrder = await nextSortOrder(tx, ctx, 'discovered');
    const now = Date.now();
    const id = newId();
    await tx
      .insert(opportunities)
      .values({
        id,
        userId: ctx.userId,
        companyId: company.id,
        roleTargetId: input.roleTargetId ?? null,
        title: input.title,
        descriptionMd: input.descriptionMd ?? null,
        postingUrl: input.postingUrl ?? null,
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef ?? null,
        location: input.location ?? null,
        remote: input.remote ?? null,
        compNote: input.compNote ?? null,
        stage: 'discovered',
        priority: input.priority ?? 2,
        sortOrder,
        dedupeKey: storedKey,
        possibleDuplicateOf,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    await tx
      .insert(stageHistory)
      .values({
        id: newId(),
        userId: ctx.userId,
        opportunityId: id,
        fromStage: null,
        toStage: 'discovered',
        note: null,
        at: now,
      })
      .run();
    await detectDedupeCandidates(
      tx,
      ctx,
      id,
      input.companyName,
      input.title,
      possibleDuplicateOf !== null,
      now,
    );
    const view = await getViewSync(tx, ctx, id);
    await indexOpportunity(tx, ctx, view);
    return view;
  });
}

/** Edits descriptive fields. Changing company, title or location re-claims the dedupe key. */
export async function updateOpportunity(
  db: Db,
  ctx: UserCtx,
  id: string,
  patch: UpdateOpportunityInput,
): Promise<OpportunityView> {
  return await withTransaction(db, async (tx) => {
    const current = await getViewSync(tx, ctx, id);
    if (patch.roleTargetId != null) await assertRoleTargetOwned(tx, ctx, patch.roleTargetId);
    const { companyName, ...fields } = patch;
    let companyId = current.companyId;
    if (companyName !== undefined)
      companyId = (await findOrCreateCompanySync(tx, ctx, companyName)).id;
    let key = current.dedupeKey;
    if (key !== null) {
      key = dedupeKey(
        companyName ?? current.companyName,
        fields.title ?? current.title,
        fields.location === undefined ? current.location : fields.location,
      );
      if (key !== current.dedupeKey) await claimDedupeKey(tx, ctx, key, id);
    }
    const now = Date.now();
    await tx
      .update(opportunities)
      .set({ ...fields, companyId, dedupeKey: key, updatedAt: now })
      .where(owned(ctx, id))
      .run();
    if (companyName !== undefined || fields.title !== undefined) {
      await detectDedupeCandidates(
        tx,
        ctx,
        id,
        companyName ?? current.companyName,
        fields.title ?? current.title,
        current.possibleDuplicateOf !== null,
        now,
      );
    }
    const view = await getViewSync(tx, ctx, id);
    if (fields.title !== undefined || fields.descriptionMd !== undefined) {
      await indexOpportunity(tx, ctx, view);
    }
    return view;
  });
}

export interface ReorderChange {
  id: string;
  sortOrder: number;
}

/**
 * Applies a whole column's manual-order renumbering in one transaction (issue #240 follow-up).
 * A full column renumber -- the shape reorderColumn produces whenever a reorder starts from a
 * tie, which every card's sortOrder default of 0 guarantees the *first* drag in an untouched
 * column will -- can touch most of a large column at once. N independent PATCH requests have
 * no atomicity: a failure partway through would leave the column's stored order inconsistent
 * with what the user was looking at, and the browser's per-origin connection cap turns N
 * requests into a queue the user can keep acting against while it drains. One transaction
 * makes it one request, all-or-nothing, instead.
 *
 * Each row is still scoped to `ctx.userId` through `owned()`; an id that is not this user's
 * (or does not exist) simply matches zero rows rather than erroring, the same permissiveness
 * `updateOpportunity` already has for a single id.
 */
export async function reorderOpportunities(
  db: Db,
  ctx: UserCtx,
  changes: ReorderChange[],
): Promise<void> {
  await withTransaction(db, async (tx) => {
    const now = Date.now();
    for (const { id, sortOrder } of changes) {
      await tx.update(opportunities).set({ sortOrder, updatedAt: now }).where(owned(ctx, id)).run();
    }
  });
}

/**
 * Records how far the search for this opportunity's posting on the company's own ATS board
 * got (design D17), and which req it found (D16). Separate from updateOpportunity because
 * none of it is user-editable and none of it touches the dedupe key or the search index.
 *
 * `atsJobRef` and `descriptionFingerprint` are left as they are when omitted, so a caller
 * can flag a state without disturbing a ref an earlier run established.
 */
export async function setPostingState(
  db: Db,
  ctx: UserCtx,
  id: string,
  patch: {
    postingState: PostingState | null;
    postingStateDetail: PostingStateDetail | null;
    atsJobRef?: AtsJobRef | null;
    descriptionFingerprint?: string | null;
  },
): Promise<OpportunityView> {
  return await withTransaction(db, async (tx) => {
    await getViewSync(tx, ctx, id);
    await tx
      .update(opportunities)
      .set({
        postingState: patch.postingState,
        postingStateDetail: patch.postingStateDetail,
        ...(patch.atsJobRef === undefined ? {} : { atsJobRef: patch.atsJobRef }),
        ...(patch.descriptionFingerprint === undefined
          ? {}
          : { descriptionFingerprint: patch.descriptionFingerprint }),
        updatedAt: Date.now(),
      })
      .where(owned(ctx, id))
      .run();
    return await getViewSync(tx, ctx, id);
  });
}

/**
 * Moves an opportunity to a new stage. Leaving closed/dismissed for a chain stage needs
 * an explicit `reopen` (Review Focus 1); everything else follows the core state machine.
 * Throws InvalidTransitionError (rendered 422) before any write.
 */
export async function transitionOpportunity(
  db: Db,
  ctx: UserCtx,
  id: string,
  change: StageChange,
): Promise<OpportunityView> {
  const view = await withTransaction(db, async (tx) => {
    const current = await getViewSync(tx, ctx, id);
    if (TERMINAL.has(current.stage) && !TERMINAL.has(change.to) && change.reopen !== true) {
      throw new InvalidTransitionError(current.stage, change.to, 'reopen required');
    }
    const result = applyTransition(current, change.to, {
      ...(change.closedReason === undefined ? {} : { closedReason: change.closedReason }),
      ...(change.dismissedReason === undefined ? {} : { dismissedReason: change.dismissedReason }),
      ...(change.note === undefined ? {} : { note: change.note }),
    });
    const { historyEntry } = result;
    // Issue #240: a card never inherits a rank from the stage it left, and self-transitions
    // are invalid (see applyTransition), so this always runs on a real stage change.
    const sortOrder = await nextSortOrder(tx, ctx, result.stage);
    await tx
      .update(opportunities)
      .set({
        stage: result.stage,
        closedReason: result.closedReason,
        dismissedReason: result.dismissedReason,
        sortOrder,
        updatedAt: historyEntry.at,
      })
      .where(owned(ctx, id))
      .run();
    await tx
      .insert(stageHistory)
      .values({ id: newId(), userId: ctx.userId, opportunityId: id, ...historyEntry })
      .run();
    if (result.stage === 'dismissed') {
      // Dismissal feedback feeds discovery prompt refinement (FR-D6).
      await tx
        .insert(dismissalFeedback)
        .values({
          id: newId(),
          userId: ctx.userId,
          kind: 'dismissal',
          opportunityId: id,
          reason: result.dismissedReason,
          note: change.note ?? null,
          at: historyEntry.at,
        })
        .run();
    }
    return await getViewSync(tx, ctx, id);
  });
  // Outside the transaction, same shape as classify.ts's enqueueEnrich-after-create: the opp
  // has just entered an active pipeline stage (issue #239) and its company has no homepage yet,
  // so resolve one. Deduped per company, so moving several opportunities of the same company
  // through the pipeline costs one job, not one per move.
  if (
    (ACTIVE_PIPELINE_STAGES as readonly string[]).includes(view.stage) &&
    view.companyDomain === null
  ) {
    await enqueueCompanyDomainResolve(db, ctx.userId, view.companyId);
  }
  return view;
}

export async function deleteOpportunity(db: Db, ctx: UserCtx, id: string): Promise<void> {
  await withTransaction(db, async (tx) => {
    // Index rows first: the activity ids are gone once the delete cascades.
    await removeOpportunityFromIndex(tx, ctx, id);
    const changes = await runCount(tx.delete(opportunities).where(owned(ctx, id)));
    if (changes === 0) throw notFound();
  });
}

// ---------------------------------------------------------------------------
// Merge (FR-O7)

/** Lifecycle position for merging: dismissed is behind everything, closed is past offer. */
function stageRank(stage: OpportunityStage): number {
  if (stage === 'dismissed') return -1;
  if (stage === 'closed') return OPPORTUNITY_STAGES.length;
  return OPPORTUNITY_STAGES.indexOf(stage);
}

/**
 * Folds `otherId` into `keepId` in one transaction: activities, next steps, communications,
 * resumes, stage history and attachments move to the kept opportunity (as do discovery results
 * and dismissal feedback that pointed at the other one); the kept opportunity takes the
 * further-forward stage; one note activity records the merge; the other row is deleted.
 */
export async function mergeOpportunities(
  db: Db,
  ctx: UserCtx,
  keepId: string,
  otherId: string,
): Promise<OpportunityView> {
  if (keepId === otherId) throw new HttpError(422, 'merge_self');
  return await withTransaction(db, async (tx) => {
    const keep = await getViewSync(tx, ctx, keepId);
    const other = await getViewSync(tx, ctx, otherId);
    const now = Date.now();
    const move = { opportunityId: keepId };
    for (const table of [
      activities,
      nextSteps,
      communications,
      resumes,
      stageHistory,
      attachments,
      discoveryResults,
      dismissalFeedback,
    ] as const) {
      await tx
        .update(table)
        .set(move)
        .where(and(eq(table.userId, ctx.userId), eq(table.opportunityId, otherId)))
        .run();
    }
    if (stageRank(other.stage) > stageRank(keep.stage)) {
      await tx
        .update(opportunities)
        .set({
          stage: other.stage,
          closedReason: other.closedReason,
          dismissedReason: other.dismissedReason,
          updatedAt: now,
        })
        .where(owned(ctx, keepId))
        .run();
      await tx
        .insert(stageHistory)
        .values({
          id: newId(),
          userId: ctx.userId,
          opportunityId: keepId,
          fromStage: keep.stage,
          toStage: other.stage,
          note: 'Stage taken from a merged duplicate.',
          at: now,
        })
        .run();
    } else {
      await tx.update(opportunities).set({ updatedAt: now }).where(owned(ctx, keepId)).run();
    }
    const note = await tx
      .insert(activities)
      .values({
        id: newId(),
        userId: ctx.userId,
        opportunityId: keepId,
        kind: 'note',
        title: `Merged duplicate: ${other.companyName}, ${other.title}`.slice(0, 500),
        bodyMd: [
          `Merged opportunity ${other.id} into this one.`,
          `Its stage was ${other.stage}; source ${other.sourceKind}.`,
          other.postingUrl === null ? null : `Posting: ${other.postingUrl}`,
        ]
          .filter((l): l is string => l !== null)
          .join('\n'),
        occurredAt: now,
        participants: [],
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    await indexActivity(tx, ctx, note);
    await removeFromIndex(tx, ctx, 'opportunity', otherId);
    await tx.delete(opportunities).where(owned(ctx, otherId)).run();
    return await getViewSync(tx, ctx, keepId);
  });
}

// ---------------------------------------------------------------------------
// Possible duplicates (#9)

/**
 * Clears the possible-duplicate flag between exactly these two opportunities, in whichever
 * direction it is actually stored: "not a duplicate" is a judgement the user made once about
 * this specific pair and must not come back on the next page load. Both ids must be the
 * caller's own; a pairing that is not actually flagged (already cleared, or never flagged) is
 * a 404, the same as naming an opportunity that does not exist.
 *
 * Also records the rejection in opportunity_dedupe_candidates (issue #94): clearing the column
 * alone, as this did before #94, left no trace that the pair had been looked at and rejected
 * rather than never evaluated, so a later heuristic run (triggered by an edit to either side)
 * would recompute the same match and set the column right back.
 */
export async function dismissPossibleDuplicate(
  db: Db,
  ctx: UserCtx,
  id: string,
  otherId: string,
): Promise<OpportunityView> {
  return await withTransaction(db, async (tx) => {
    await getViewSync(tx, ctx, id);
    await getViewSync(tx, ctx, otherId);
    const now = Date.now();
    const cleared = await runCount(
      tx
        .update(opportunities)
        .set({ possibleDuplicateOf: null, updatedAt: now })
        .where(
          or(
            and(
              eq(opportunities.userId, ctx.userId),
              eq(opportunities.id, id),
              eq(opportunities.possibleDuplicateOf, otherId),
            ),
            and(
              eq(opportunities.userId, ctx.userId),
              eq(opportunities.id, otherId),
              eq(opportunities.possibleDuplicateOf, id),
            ),
          ),
        ),
    );
    if (cleared === 0) throw notFound();
    await rejectDedupeCandidate(tx, ctx, id, otherId, 'user', now);
    return await getViewSync(tx, ctx, id);
  });
}
