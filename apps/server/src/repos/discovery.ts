// Discovery sources, runs and results (FR-D1..D3). Every function is scoped to the caller: a
// source, run or result of another user is a 404, and a reference (role target, company,
// source, run) must be the caller's own.
import {
  newId,
  type Disposition,
  type NormalizedPosting,
  type RankSkipReason,
  type Resolution,
} from '@opportun/core';
import {
  and,
  asc,
  count,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import { SOURCE_CONFIG_SCHEMAS, type SourceKind } from '../adapters/discoverySource';
import {
  communications,
  companies,
  discoveryResults,
  discoveryRuns,
  discoverySources,
  dismissalFeedback,
  opportunities,
  roleTargets,
} from '../db/schema';
import { descNullsLast, jsonText, likePrefix } from '../db/dialect';
import { HttpError, notFound } from '../lib/errors';
import { isBoardSource, prefilter, prefilterHolds, type PrefilterVerdict } from '../lib/prefilter';
import { PREFILTER_ON_POSITIVES, PREFILTER_ON_RECALL_PERCENT } from '../lib/prefilter';
import { DISCOVERY_RUN_KIND } from '../jobs/discoveryKinds';
import { removeSchedule, setSchedule, userCronProblem } from '../jobs/runner';
import type { Db, Exec, UserCtx } from './base';
import { getOpportunity } from './opportunities';
import { countWhere, orderBy, sortColumns, type ListOpts, type Page } from './list';
import { startOfUtcDay } from './taskRuns';
import { runCount, withTransaction } from '../db/client';

export type DiscoverySourceRow = typeof discoverySources.$inferSelect;
export type DiscoveryRunRow = typeof discoveryRuns.$inferSelect;
export type DiscoveryResultRow = typeof discoveryResults.$inferSelect;

/** A result as the API returns it: the row plus where it came from. */
export type DiscoveryResultView = Omit<DiscoveryResultRow, 'posting'> & {
  posting: NormalizedPosting;
  sourceId: string;
  sourceKind: SourceKind;
  roleTargetId: string | null;
  /** The source message's channel and id, when this lead came from one (design D3b). */
  sourceMailChannel: string | null;
  sourceMailExternalId: string | null;
  /** Why a dismissed result was dismissed (issue #199); null unless disposition is dismissed. */
  dismissReason: string | null;
  dismissNote: string | null;
};

/** The schedule row name (`schedule:<name>`) that runs one source on its cron. */
export const sourceScheduleName = (sourceId: string): string => `${DISCOVERY_RUN_KIND}:${sourceId}`;

/**
 * An enabled source with a cron gets its own schedule row (owned by the user, so it goes with
 * the account); any other source has none, and a pending scheduled run is dropped.
 */
async function syncSourceSchedule(db: Db, ctx: UserCtx, source: DiscoverySourceRow): Promise<void> {
  const name = sourceScheduleName(source.id);
  if (source.enabled && source.scheduleCron !== null) {
    await setSchedule(
      db,
      name,
      {
        cron: source.scheduleCron,
        enabled: true,
        kind: DISCOVERY_RUN_KIND,
        payload: { sourceId: source.id },
      },
      ctx.userId,
    );
  } else {
    await removeSchedule(db, name);
  }
}

/** The key under which the engine keeps an adapter's paging cursor inside a source's config. */
export const CURSOR_KEY = 'cursor';

export interface SourceInput {
  kind: SourceKind;
  config?: Record<string, unknown> | undefined;
  enabled?: boolean | undefined;
  prefilterEnabled?: boolean | undefined;
  scheduleCron?: string | null | undefined;
  roleTargetId?: string | null | undefined;
  companyId?: string | null | undefined;
}

export type SourcePatch = Partial<Omit<SourceInput, 'kind'>>;

// ---------------------------------------------------------------------------
// Validation helpers

function validConfig(kind: SourceKind, config: Record<string, unknown>): Record<string, unknown> {
  // eslint-disable-next-line security/detect-object-injection -- kind is a SourceKind literal
  const parsed = SOURCE_CONFIG_SCHEMAS[kind].safeParse(config);
  if (!parsed.success) {
    const message = z.prettifyError(parsed.error).slice(0, 500);
    throw new HttpError(422, 'invalid_config', message, { message });
  }
  return parsed.data;
}

/**
 * An MCP stdio source runs a command the user typed on the server (ADR-12). In a shared install
 * only the administrator may configure one; any user may use an https MCP server.
 */
function assertMayConfigure(ctx: UserCtx, kind: SourceKind, config: Record<string, unknown>): void {
  if (kind === 'mcp' && config.transport === 'stdio' && !ctx.isAdmin) {
    throw new HttpError(403, 'mcp_stdio_admin_only');
  }
}

function assertCron(cron: string | null | undefined): void {
  if (cron === null || cron === undefined) return;
  if (cron.length > 100) {
    throw new HttpError(422, 'invalid_cron', undefined, {
      message: 'must be at most 100 characters',
    });
  }
  const problem = userCronProblem(cron);
  if (problem !== null) throw new HttpError(422, 'invalid_cron', undefined, { message: problem });
}

async function assertOwned(exec: Exec, ctx: UserCtx, input: SourcePatch): Promise<void> {
  if (input.roleTargetId != null) {
    const row = await exec
      .select({ id: roleTargets.id })
      .from(roleTargets)
      .where(and(eq(roleTargets.userId, ctx.userId), eq(roleTargets.id, input.roleTargetId)))
      .get();
    if (row === undefined) throw notFound();
  }
  if (input.companyId != null) {
    const row = await exec
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.userId, ctx.userId), eq(companies.id, input.companyId)))
      .get();
    if (row === undefined) throw notFound();
  }
}

function ownedSource(ctx: UserCtx, id: string): SQL | undefined {
  return and(eq(discoverySources.userId, ctx.userId), eq(discoverySources.id, id));
}

// ---------------------------------------------------------------------------
// Sources

export const SOURCE_SORTS = sortColumns({
  createdAt: discoverySources.createdAt,
  updatedAt: discoverySources.updatedAt,
  lastRunAt: discoverySources.lastRunAt,
  kind: discoverySources.kind,
});

export async function getSourceRow(
  exec: Exec,
  ctx: UserCtx,
  id: string,
): Promise<DiscoverySourceRow> {
  const row = await exec.select().from(discoverySources).where(ownedSource(ctx, id)).get();
  if (row === undefined) throw notFound();
  return row;
}

export async function listSources(
  db: Db,
  ctx: UserCtx,
  opts: ListOpts & { kind?: SourceKind | undefined },
): Promise<Page<DiscoverySourceRow>> {
  const where = and(
    eq(discoverySources.userId, ctx.userId),
    opts.kind === undefined ? undefined : eq(discoverySources.kind, opts.kind),
  );
  const items = await db
    .select()
    .from(discoverySources)
    .where(where)
    .orderBy(...orderBy(opts.sort, 'createdAt', SOURCE_SORTS, discoverySources.id))
    .limit(opts.limit)
    .offset(opts.offset)
    .all();
  return { items, total: await countWhere(db, discoverySources, where) };
}

export async function createSource(
  db: Db,
  ctx: UserCtx,
  input: SourceInput,
): Promise<DiscoverySourceRow> {
  const config = validConfig(input.kind, input.config ?? {});
  assertMayConfigure(ctx, input.kind, config);
  assertCron(input.scheduleCron);
  const created = await withTransaction(db, async (tx) => {
    await assertOwned(tx, ctx, input);
    const now = Date.now();
    const id = newId();
    await tx
      .insert(discoverySources)
      .values({
        id,
        userId: ctx.userId,
        kind: input.kind,
        config,
        enabled: input.enabled ?? true,
        prefilterEnabled: input.prefilterEnabled ?? true,
        scheduleCron: input.scheduleCron ?? null,
        roleTargetId: input.roleTargetId ?? null,
        companyId: input.companyId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return await getSourceRow(tx, ctx, id);
  });
  await syncSourceSchedule(db, ctx, created);
  return created;
}

/**
 * The user's synthetic source for a channel that delivers postings itself (alert_email, manual,
 * extension): the oldest one of that kind, created (enabled, unscheduled, empty config) on
 * first use.
 */
export async function ensureChannelSource(
  db: Db,
  ctx: UserCtx,
  kind: 'alert_email' | 'manual' | 'extension',
): Promise<DiscoverySourceRow> {
  const existing = await db
    .select()
    .from(discoverySources)
    .where(and(eq(discoverySources.userId, ctx.userId), eq(discoverySources.kind, kind)))
    .orderBy(asc(discoverySources.createdAt), asc(discoverySources.id))
    .get();
  return existing ?? (await createSource(db, ctx, { kind, config: {}, enabled: true }));
}

/** A new config replaces the old one entirely, so the adapter's cursor starts over. */
export async function updateSource(
  db: Db,
  ctx: UserCtx,
  id: string,
  patch: SourcePatch,
): Promise<DiscoverySourceRow> {
  const updated = await withTransaction(db, async (tx) => {
    const current = await getSourceRow(tx, ctx, id);
    const config = patch.config === undefined ? undefined : validConfig(current.kind, patch.config);
    if (config !== undefined) assertMayConfigure(ctx, current.kind, config);
    assertCron(patch.scheduleCron);
    await assertOwned(tx, ctx, patch);
    await tx
      .update(discoverySources)
      .set({
        ...(config === undefined ? {} : { config }),
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        ...(patch.prefilterEnabled === undefined
          ? {}
          : { prefilterEnabled: patch.prefilterEnabled }),
        ...(patch.scheduleCron === undefined ? {} : { scheduleCron: patch.scheduleCron }),
        ...(patch.roleTargetId === undefined ? {} : { roleTargetId: patch.roleTargetId }),
        ...(patch.companyId === undefined ? {} : { companyId: patch.companyId }),
        updatedAt: Date.now(),
      })
      .where(ownedSource(ctx, id))
      .run();
    return await getSourceRow(tx, ctx, id);
  });
  if (patch.enabled !== undefined || patch.scheduleCron !== undefined) {
    await syncSourceSchedule(db, ctx, updated);
  }
  return updated;
}

/** Deletes the source and its schedule; its runs and results cascade. */
export async function deleteSource(db: Db, ctx: UserCtx, id: string): Promise<void> {
  const changes = await runCount(db.delete(discoverySources).where(ownedSource(ctx, id)));
  if (changes === 0) throw notFound();
  await removeSchedule(db, sourceScheduleName(id));
}

/** Health after a run: 'ok' clears the detail; 'error' keeps a bounded reason. */
export async function setSourceStatus(
  exec: Exec,
  ctx: UserCtx,
  id: string,
  status: DiscoverySourceRow['status'],
  detail: string | null,
  at: number = Date.now(),
): Promise<void> {
  await exec
    .update(discoverySources)
    .set({
      status,
      statusDetail: status === 'ok' ? null : (detail ?? '').slice(0, 300),
      lastRunAt: at,
      updatedAt: at,
    })
    .where(ownedSource(ctx, id))
    .run();
}

/** Stores the adapter's resume point next to the source's own config. */
export async function saveSourceCursor(
  exec: Exec,
  ctx: UserCtx,
  id: string,
  cursor: unknown,
): Promise<void> {
  const current = await getSourceRow(exec, ctx, id);
  await exec
    .update(discoverySources)
    .set({ config: { ...current.config, [CURSOR_KEY]: cursor ?? null }, updatedAt: Date.now() })
    .where(ownedSource(ctx, id))
    .run();
}

/** The source's config as its adapter sees it (without the engine's cursor) and the cursor. */
export function splitConfig(source: DiscoverySourceRow): {
  config: Record<string, unknown>;
  cursor: unknown | null;
} {
  const { [CURSOR_KEY]: cursor, ...config } = source.config;
  return { config, cursor: cursor ?? null };
}

// ---------------------------------------------------------------------------
// Runs

export const RUN_SORTS = sortColumns({ startedAt: discoveryRuns.startedAt });

function ownedRun(ctx: UserCtx, id: string): SQL | undefined {
  return and(eq(discoveryRuns.userId, ctx.userId), eq(discoveryRuns.id, id));
}

export async function getRun(exec: Exec, ctx: UserCtx, id: string): Promise<DiscoveryRunRow> {
  const row = await exec.select().from(discoveryRuns).where(ownedRun(ctx, id)).get();
  if (row === undefined) throw notFound();
  return row;
}

export async function createRun(
  exec: Exec,
  ctx: UserCtx,
  input: { sourceId: string; roleTargetId?: string | null | undefined },
): Promise<DiscoveryRunRow> {
  const source = await getSourceRow(exec, ctx, input.sourceId);
  const roleTargetId = input.roleTargetId === undefined ? source.roleTargetId : input.roleTargetId;
  await assertOwned(exec, ctx, { roleTargetId });
  const id = newId();
  await exec
    .insert(discoveryRuns)
    .values({
      id,
      userId: ctx.userId,
      sourceId: source.id,
      roleTargetId,
      startedAt: Date.now(),
    })
    .run();
  return await getRun(exec, ctx, id);
}

export type RunOutcome =
  | { stats: Record<string, unknown>; error?: undefined }
  | { error: string; stats?: Record<string, unknown> | undefined };

export async function finishRun(
  exec: Exec,
  ctx: UserCtx,
  runId: string,
  outcome: RunOutcome,
): Promise<DiscoveryRunRow> {
  await getRun(exec, ctx, runId);
  await exec
    .update(discoveryRuns)
    .set({
      finishedAt: Date.now(),
      stats: outcome.stats ?? null,
      error: outcome.error === undefined ? null : outcome.error.slice(0, 2000),
    })
    .where(ownedRun(ctx, runId))
    .run();
  return await getRun(exec, ctx, runId);
}

export async function listRuns(
  db: Db,
  ctx: UserCtx,
  sourceId: string,
  opts: ListOpts,
): Promise<Page<DiscoveryRunRow>> {
  const where = and(eq(discoveryRuns.userId, ctx.userId), eq(discoveryRuns.sourceId, sourceId));
  const items = await db
    .select()
    .from(discoveryRuns)
    .where(where)
    .orderBy(...orderBy(opts.sort, '-startedAt', RUN_SORTS, discoveryRuns.id))
    .limit(opts.limit)
    .offset(opts.offset)
    .all();
  return { items, total: await countWhere(db, discoveryRuns, where) };
}

// ---------------------------------------------------------------------------
// Results

/** Default order is best score first; unranked results (null score) sort last. */
export const RESULT_SORTS = sortColumns({
  ai_score: discoveryResults.aiScore,
  createdAt: discoveryResults.createdAt,
  updatedAt: discoveryResults.updatedAt,
});

const resultColumns = {
  ...getTableColumns(discoveryResults),
  sourceId: discoveryRuns.sourceId,
  sourceKind: discoverySources.kind,
  roleTargetId: discoveryRuns.roleTargetId,
  // The source message's own identifiers, which are what a deep link back to it is built from
  // (design D3b). Joined rather than stored: no URL is kept anywhere.
  sourceMailChannel: communications.channel,
  sourceMailExternalId: communications.externalId,
  // Why a dismissed result was dismissed (issue #199): null for a pending or accepted result,
  // and for a dismissed one from before this column was read back at all. A result can be
  // dismissed at most once (the dismiss routes 409 on anything not still pending), so this join
  // is never ambiguous about which feedback row it means.
  dismissReason: dismissalFeedback.reason,
  dismissNote: dismissalFeedback.note,
};

function selectResults(exec: Exec) {
  return exec
    .select(resultColumns)
    .from(discoveryResults)
    .innerJoin(discoveryRuns, eq(discoveryRuns.id, discoveryResults.runId))
    .innerJoin(discoverySources, eq(discoverySources.id, discoveryRuns.sourceId))
    .leftJoin(communications, eq(communications.id, discoveryResults.sourceCommunicationId))
    .leftJoin(
      dismissalFeedback,
      and(
        eq(dismissalFeedback.resultId, discoveryResults.id),
        eq(dismissalFeedback.kind, 'dismissal'),
      ),
    );
}

function ownedResult(ctx: UserCtx, id: string): SQL | undefined {
  return and(eq(discoveryResults.userId, ctx.userId), eq(discoveryResults.id, id));
}

function toView(
  row: Awaited<ReturnType<ReturnType<typeof selectResults>['get']>>,
): DiscoveryResultView {
  if (row === undefined) throw notFound();
  return { ...row, posting: row.posting as NormalizedPosting };
}

export async function getResult(
  exec: Exec,
  ctx: UserCtx,
  id: string,
): Promise<DiscoveryResultView> {
  return toView(await selectResults(exec).where(ownedResult(ctx, id)).get());
}

export interface ResultFilters {
  disposition?: Disposition | undefined;
  sourceId?: string | undefined;
}

export async function listResults(
  db: Db,
  ctx: UserCtx,
  opts: ListOpts & ResultFilters,
): Promise<Page<DiscoveryResultView>> {
  const where = and(
    eq(discoveryResults.userId, ctx.userId),
    opts.disposition === undefined ? undefined : eq(discoveryResults.disposition, opts.disposition),
    opts.sourceId === undefined ? undefined : eq(discoveryRuns.sourceId, opts.sourceId),
  );
  const items = (
    await selectResults(db)
      .where(where)
      .orderBy(...orderBy(opts.sort, '-ai_score', RESULT_SORTS, discoveryResults.id))
      .limit(opts.limit)
      .offset(opts.offset)
      .all()
  ).map((r) => ({ ...r, posting: r.posting as NormalizedPosting }));
  const total =
    (
      await db
        .select({ n: count() })
        .from(discoveryResults)
        .innerJoin(discoveryRuns, eq(discoveryRuns.id, discoveryResults.runId))
        .where(where)
        .get()
    )?.n ?? 0;
  return { items, total };
}

export interface ResultInput {
  runId: string;
  posting: NormalizedPosting;
  dedupeKey: string | null;
  resolution: Resolution;
  aiRationale?: string | null | undefined;
  /** A posting a board's first run holds below the cut (#215) starts with its reason. */
  rankSkipReason?: RankSkipReason | null | undefined;
  /** The message this lead was parsed out of, for a channel that delivers postings by mail. */
  sourceCommunicationId?: string | null | undefined;
  /** The pre-filter's verdict (#217), for a board posting; absent for any other. */
  prefilter?: PrefilterVerdict | null | undefined;
}

export async function insertResult(
  exec: Exec,
  ctx: UserCtx,
  input: ResultInput,
): Promise<DiscoveryResultView> {
  await getRun(exec, ctx, input.runId);
  const now = Date.now();
  const id = newId();
  await exec
    .insert(discoveryResults)
    .values({
      id,
      userId: ctx.userId,
      runId: input.runId,
      posting: input.posting,
      dedupeKey: input.dedupeKey,
      resolution: input.resolution,
      aiRationale: input.aiRationale ?? null,
      rankSkipReason: input.rankSkipReason ?? null,
      sourceCommunicationId: input.sourceCommunicationId ?? null,
      prefilterOutcome: input.prefilter?.outcome ?? null,
      prefilterRule: input.prefilter?.rule ?? null,
      prefilterScore: input.prefilter?.score ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return await getResult(exec, ctx, id);
}

export async function setDisposition(
  exec: Exec,
  ctx: UserCtx,
  id: string,
  disposition: Disposition,
  opportunityId?: string | null,
): Promise<DiscoveryResultView> {
  await getResult(exec, ctx, id);
  await exec
    .update(discoveryResults)
    .set({
      disposition,
      ...(opportunityId === undefined ? {} : { opportunityId }),
      updatedAt: Date.now(),
    })
    .where(ownedResult(ctx, id))
    .run();
  return await getResult(exec, ctx, id);
}

/** Stage an already-accepted role is still eligible to receive another member of its own
 *  location group (issue #226): a role already applied to or further along may be getting a
 *  genuinely new posting, not a location variant, so it is excluded rather than silently
 *  extended. The owner has the final word on exactly where this line sits; see #226. */
const CHAINABLE_STAGES = ['discovered', 'interested'] as const;

/**
 * The opportunity an already-accepted result sharing `groupKey` (dedupeGroupKey's company+title,
 * issue #209) produced, if one both exists and is still eligible (issue #226). Scoped to THIS
 * user's own data, the same as every other lookup in this file.
 *
 * `groupKey` is always `dedupeGroupKey(someStoredDedupeKey)`, already lowercased by
 * dedupeKey's own normalize(): matched as a case-sensitive LIKE *prefix* (db/dialect.ts's
 * likePrefix, `groupKey|` plus anything), not a contains pattern, so it is a range scan on
 * discovery_results_user_dedupe_idx(user_id, dedupe_key), not a table scan or a full scan
 * defeated by SQLite's case-insensitive LIKE (measured with EXPLAIN QUERY PLAN; see #226).
 */
export async function findChainTarget(
  exec: Exec,
  ctx: UserCtx,
  groupKey: string,
): Promise<string | undefined> {
  const row = await exec
    .select({ opportunityId: discoveryResults.opportunityId })
    .from(discoveryResults)
    .innerJoin(opportunities, eq(opportunities.id, discoveryResults.opportunityId))
    .where(
      and(
        eq(discoveryResults.userId, ctx.userId),
        likePrefix(discoveryResults.dedupeKey, `${groupKey}|`),
        inArray(opportunities.stage, CHAINABLE_STAGES),
      ),
    )
    .orderBy(asc(opportunities.createdAt))
    .limit(1)
    .get();
  return row?.opportunityId ?? undefined;
}

/**
 * Lets a decided result's dedupe key go, so the next posting that lands on it is evaluated
 * fresh by `checkDuplicate` instead of suppressed forever (#11), without touching this row's
 * own disposition, score, or dismissal feedback: what happened to it stays recorded exactly as
 * it was, it just stops holding the key. Mirrors `claimDedupeKey` in repos/opportunities.ts,
 * which already does the equivalent thing for a dismissed opportunity (`dedupeKey: null`) the
 * moment the user creates a new one past it — this is that same release, but as an explicit
 * action here rather than implicit in another create, since discovery ingestion runs on its
 * own schedule with no "the user is creating something new" moment to hang it on.
 *
 * Only ever happens on this call: passive discovery polling never releases a key by itself, so
 * every already-decided result keeps suppressing exactly as before until a user acts on it.
 * Accepted results stay blocked unless their opportunity has itself been dismissed from the
 * pipeline (mirroring `hasLiveDuplicate`'s "dismissed means not live" rule) — while that
 * opportunity is still active, the key SHOULD keep blocking reposts of a job already tracked.
 */
export async function unsuppressResult(
  db: Db,
  ctx: UserCtx,
  id: string,
): Promise<DiscoveryResultView> {
  const result = await getResult(db, ctx, id);
  if (result.disposition === 'pending') throw new HttpError(409, 'already_pending');
  if (result.disposition === 'accepted') {
    if (result.opportunityId === null) throw new HttpError(409, 'no_linked_opportunity');
    const opp = await getOpportunity(db, ctx, result.opportunityId);
    if (opp.stage !== 'dismissed') throw new HttpError(409, 'opportunity_still_active');
  }
  if (result.dedupeKey === null) throw new HttpError(409, 'not_suppressing');
  await db
    .update(discoveryResults)
    .set({ dedupeKey: null, updatedAt: Date.now() })
    .where(ownedResult(ctx, id))
    .run();
  return await getResult(db, ctx, id);
}

/** Stores the ranking (score null: not ranked, e.g. no AI available). */
export async function setRanking(
  exec: Exec,
  ctx: UserCtx,
  id: string,
  ranking: { aiScore: number | null; aiRationale: string | null },
): Promise<DiscoveryResultView> {
  await getResult(exec, ctx, id);
  // Ranked now, so any earlier reason it was not, and any wait for budget, is cleared (#210, #214).
  await exec
    .update(discoveryResults)
    .set({ ...ranking, rankSkipReason: null, rankDeferredAt: null, updatedAt: Date.now() })
    .where(ownedResult(ctx, id))
    .run();
  return await getResult(exec, ctx, id);
}

/** The parts of a stored posting the recall figure reads; an older shape is simply not counted. */
const RecallPostingSchema = z.object({
  title: z.string(),
  location: z.string().nullish(),
  remote: z.boolean().nullish(),
});

/**
 * How the pre-filter would have done on what the user decided (#217, tl's proposal 4.3): of the
 * postings they accepted from job boards, how many it keeps. Accepted (moved to the pipeline) is
 * the only "wanted" a result records.
 *
 * Worked out now rather than read from the verdict stored at ingest, so decisions from before the
 * filter count, and an edited list or role target moves the figure. Each posting is judged as a
 * new one from its source would be: against that source's own role target, else every active one.
 * A posting with no target to judge against is not counted. Recall is null with none yet.
 */
export interface PrefilterStatus {
  /** Accepted board postings it could judge: what recall is based on. */
  positives: number;
  kept: number;
  recall: number | null;
  /** Whether recall holds, so that board sources act on the verdicts (#218). */
  on: boolean;
  neededRecall: number;
  neededPositives: number;
  /** Postings it judged when they arrived, and those it filtered: the share it would remove. */
  judged: number;
  filtered: number;
}

export async function prefilterRecall(exec: Exec, ctx: UserCtx): Promise<PrefilterStatus> {
  const accepted = await exec
    .select({
      posting: discoveryResults.posting,
      kind: discoverySources.kind,
      roleTargetId: discoverySources.roleTargetId,
    })
    .from(discoveryResults)
    .innerJoin(discoveryRuns, eq(discoveryRuns.id, discoveryResults.runId))
    .innerJoin(discoverySources, eq(discoverySources.id, discoveryRuns.sourceId))
    .where(
      and(eq(discoveryResults.userId, ctx.userId), eq(discoveryResults.disposition, 'accepted')),
    )
    .all();
  const targets = await exec
    .select()
    .from(roleTargets)
    .where(eq(roleTargets.userId, ctx.userId))
    .all();
  const active = targets.filter((t) => t.active);
  let positives = 0;
  let kept = 0;
  for (const { posting, kind, roleTargetId } of accepted) {
    if (!isBoardSource(kind)) continue;
    const parsed = RecallPostingSchema.safeParse(posting);
    if (!parsed.success) continue;
    const verdict = prefilter(
      parsed.data,
      roleTargetId === null ? active : targets.filter((t) => t.id === roleTargetId),
    );
    if (verdict === null) continue;
    positives += 1;
    if (verdict.outcome === 'pass') kept += 1;
  }
  // Stored verdicts, as judged when each posting arrived, where recall above is worked out live
  // against today's role targets: after a target is edited the two can disagree.
  const verdicts = await exec
    .select({ outcome: discoveryResults.prefilterOutcome, n: count() })
    .from(discoveryResults)
    .where(
      and(eq(discoveryResults.userId, ctx.userId), isNotNull(discoveryResults.prefilterOutcome)),
    )
    .groupBy(discoveryResults.prefilterOutcome)
    .all();
  const tally = (outcome: string) => Number(verdicts.find((v) => v.outcome === outcome)?.n ?? 0);
  const filtered = tally('filtered');
  return {
    positives,
    kept,
    recall: positives === 0 ? null : kept / positives,
    on: prefilterHolds(kept, positives),
    neededRecall: PREFILTER_ON_RECALL_PERCENT / 100,
    neededPositives: PREFILTER_ON_POSITIVES,
    judged: tally('pass') + filtered,
    filtered,
  };
}

/**
 * Records why ranking was skipped (#210): the AI router's reason, shown on the result's card
 * until it is ranked. Only the reason is written. A result that already has a score keeps none:
 * it is ranked, so it must never read "not ranked" (tl on #213).
 */
export async function setRankSkip(
  exec: Exec,
  ctx: UserCtx,
  id: string,
  reason: RankSkipReason,
): Promise<void> {
  await exec
    .update(discoveryResults)
    .set({ rankSkipReason: reason })
    .where(and(ownedResult(ctx, id), isNull(discoveryResults.aiScore)))
    .run();
}

/**
 * The result waits for the discovery budget (#214): it is ranked on a later budget day, oldest
 * first (jobs/discoveryRankWaiting.ts). A second refusal keeps the first time, and drops any older
 * reason, since the budget is what holds it now. A scored result keeps its score while its re-rank
 * waits. Like a skip, this leaves updatedAt alone.
 */
export async function setRankDeferred(
  exec: Exec,
  ctx: UserCtx,
  id: string,
  now: number = Date.now(),
): Promise<void> {
  await exec
    .update(discoveryResults)
    .set({
      rankDeferredAt: sql`coalesce(${discoveryResults.rankDeferredAt}, ${now})`,
      rankSkipReason: null,
    })
    .where(ownedResult(ctx, id))
    .run();
}

/** The result stops waiting for budget, without being ranked. */
export async function clearRankDeferred(exec: Exec, ctx: UserCtx, id: string): Promise<void> {
  await exec
    .update(discoveryResults)
    .set({ rankDeferredAt: null })
    .where(ownedResult(ctx, id))
    .run();
}

/**
 * A posting the pre-filter passed, then one it never judged, then one it filtered: it must not go
 * ahead of a job alert, which the owner's decision 5 on #190 says is never filtered.
 */
const verdictOrder = sql`case ${discoveryResults.prefilterOutcome} when 'pass' then 0 when 'filtered' then 2 else 1 end`;

const waitingForBudget = and(
  isNotNull(discoveryResults.rankDeferredAt),
  eq(discoveryResults.disposition, 'pending'),
);

/**
 * Waiting postings still in line for a turn. A posting the provider refused today has had today's
 * turn, or a few that always fail would be first on every drain and the backlog behind them would
 * never be reached. On a later budget day it is back in line by date, or new postings could spend
 * each day's budget ahead of it for ever. A no-key or rejected-key reason is not in line: it holds
 * nothing up while the key is missing or refused, and it ends when a key works
 * (clearWaitingKeyReasons).
 */
const inLineForBudget = (now: number) =>
  or(
    isNull(discoveryResults.rankSkipReason),
    and(
      eq(discoveryResults.rankSkipReason, 'provider_error'),
      lt(discoveryResults.rankDeferredAt, startOfUtcDay(now)),
    ),
  );

/**
 * The caller's results waiting for budget, in the order a drain takes them. Those still unranked
 * and in line come first, or a posting refused today could lead every drain on its title alone.
 * Then the best pre-filter match (#218, the owner's decision 2 on #190): one that passed, one it
 * never judged, then one it filtered, since the score is the title's alone and a perfect title in
 * the wrong place is no best match, then by score, then oldest. Best first can starve: with more good new postings
 * each day than the budget ranks, a poor older one can wait for as long as that lasts.
 */
export async function listWaitingResultIds(
  exec: Exec,
  ctx: UserCtx,
  now: number = Date.now(),
): Promise<string[]> {
  const rows = await exec
    .select({ id: discoveryResults.id })
    .from(discoveryResults)
    .where(and(eq(discoveryResults.userId, ctx.userId), waitingForBudget))
    .orderBy(
      sql`case when ${and(inLineForBudget(now), isNull(discoveryResults.aiScore))} then 0 else 1 end`,
      verdictOrder,
      descNullsLast(discoveryResults.prefilterScore),
      asc(discoveryResults.createdAt),
      asc(discoveryResults.id),
    )
    .all();
  return rows.map((r) => r.id);
}

/** Whether a posting older than this pending one is still in line for budget. */
export async function hasOlderWaitingResult(
  exec: Exec,
  ctx: UserCtx,
  id: string,
  now: number = Date.now(),
): Promise<boolean> {
  const self = await exec
    .select({
      createdAt: discoveryResults.createdAt,
      disposition: discoveryResults.disposition,
    })
    .from(discoveryResults)
    .where(ownedResult(ctx, id))
    .get();
  if (self === undefined || self.disposition !== 'pending') return false;
  const older = await exec
    .select({ id: discoveryResults.id })
    .from(discoveryResults)
    .where(
      and(
        eq(discoveryResults.userId, ctx.userId),
        waitingForBudget,
        inLineForBudget(now),
        or(
          lt(discoveryResults.createdAt, self.createdAt),
          and(eq(discoveryResults.createdAt, self.createdAt), lt(discoveryResults.id, id)),
        ),
      ),
    )
    .limit(1)
    .get();
  return older !== undefined;
}

/**
 * Joins the wait, unless a ranking landed since the caller looked: a rank job that was running can
 * finish at any moment, and its score must not read as a re-rank waiting.
 */
export async function setRankWaitingIfUnranked(
  exec: Exec,
  ctx: UserCtx,
  id: string,
  now: number = Date.now(),
): Promise<void> {
  await exec
    .update(discoveryResults)
    .set({ rankDeferredAt: now })
    .where(
      and(
        ownedResult(ctx, id),
        isNull(discoveryResults.aiScore),
        isNull(discoveryResults.rankDeferredAt),
      ),
    )
    .run();
}

/** The provider refused this waiting posting: today's turn is used (inLineForBudget). */
export async function setRankTurnUsed(
  exec: Exec,
  ctx: UserCtx,
  id: string,
  now: number = Date.now(),
): Promise<void> {
  await exec
    .update(discoveryResults)
    .set({ rankDeferredAt: now })
    .where(and(ownedResult(ctx, id), isNotNull(discoveryResults.rankDeferredAt)))
    .run();
}

/**
 * No key means nothing behind this posting can be ranked either: every unscored waiting card says
 * so at once, with no further call to find that out. A scored one keeps its score and no reason.
 */
export async function setWaitingNoKey(exec: Exec, ctx: UserCtx): Promise<void> {
  await exec
    .update(discoveryResults)
    .set({ rankSkipReason: 'no_key' })
    .where(
      and(
        eq(discoveryResults.userId, ctx.userId),
        waitingForBudget,
        isNull(discoveryResults.aiScore),
      ),
    )
    .run();
}

/**
 * A key works: it was added, or a call got through. No waiting card should still say AI is not set
 * up, and those postings are back in line, so new ones go behind them again.
 */
export async function clearWaitingKeyReasons(exec: Exec, ctx: UserCtx): Promise<void> {
  // Whatever the disposition: a dismissed posting's wait survives for Undo (tl on #230), and its
  // reason must not, or Undo would turn a rejected key's stop back on with a working key.
  await exec
    .update(discoveryResults)
    .set({ rankSkipReason: null })
    .where(
      and(
        eq(discoveryResults.userId, ctx.userId),
        isNotNull(discoveryResults.rankDeferredAt),
        inArray(discoveryResults.rankSkipReason, ['no_key', 'key_rejected']),
      ),
    )
    .run();
}

/**
 * The provider rejected the caller's key, so every unscored posting waiting says so, and the sweep
 * passes this user over (usersWithRejectedKey). A scored posting is never marked: it is ranked, so
 * it must never read "Not ranked" (tl on #213).
 */
export async function setWaitingKeyRejected(exec: Exec, ctx: UserCtx): Promise<void> {
  await exec
    .update(discoveryResults)
    .set({ rankSkipReason: 'key_rejected' })
    .where(
      and(
        eq(discoveryResults.userId, ctx.userId),
        waitingForBudget,
        isNull(discoveryResults.aiScore),
      ),
    )
    .run();
}

/**
 * A ranking got a rejected key: the posting joins the wait with the reason, written together
 * because setRankDeferred clears the reason. Joining is what gets it ranked once a key works: the
 * ways back and the drain only reach waiting postings. A scored posting keeps its score, unmarked.
 */
export async function setRankKeyRejected(
  exec: Exec,
  ctx: UserCtx,
  id: string,
  now: number = Date.now(),
): Promise<void> {
  await exec
    .update(discoveryResults)
    .set({
      rankSkipReason: 'key_rejected',
      rankDeferredAt: sql`coalesce(${discoveryResults.rankDeferredAt}, ${now})`,
    })
    .where(and(ownedResult(ctx, id), isNull(discoveryResults.aiScore)))
    .run();
}

/** How many of the caller's results wait for budget. Each is one row, so each counts once. */
export async function countWaitingResults(exec: Exec, ctx: UserCtx): Promise<number> {
  const row = await exec
    .select({ n: count() })
    .from(discoveryResults)
    .where(and(eq(discoveryResults.userId, ctx.userId), waitingForBudget))
    .get();
  return Number(row?.n ?? 0);
}

/**
 * Users with any waiting posting marked key_rejected. Any, not all: scored postings are never
 * marked, so one waiting would otherwise keep the sweep calling every hour. Every way back clears
 * every mark, so one mark means the stop is on.
 */
export async function usersWithRejectedKey(exec: Exec): Promise<Set<string>> {
  const rows = await exec
    .selectDistinct({ userId: discoveryResults.userId })
    .from(discoveryResults)
    .where(and(waitingForBudget, eq(discoveryResults.rankSkipReason, 'key_rejected')))
    .all();
  return new Set(rows.map((r) => r.userId));
}

/** The users with a result waiting for budget (the sweep's list). */
export async function usersWithWaitingResults(exec: Exec): Promise<string[]> {
  const rows = await exec
    .selectDistinct({ userId: discoveryResults.userId })
    .from(discoveryResults)
    .where(waitingForBudget)
    .all();
  return rows.map((r) => r.userId);
}

/**
 * Whether this source has a run that finished without an error. A board's first run is the first
 * that does (#215): the same run #209's figures treat as its backfill. One that failed may have
 * stored postings, and its retries are still the first run.
 */
export async function hasSucceededRun(
  exec: Exec,
  ctx: UserCtx,
  sourceId: string,
): Promise<boolean> {
  const row = await exec
    .select({ id: discoveryRuns.id })
    .from(discoveryRuns)
    .where(
      and(
        eq(discoveryRuns.userId, ctx.userId),
        eq(discoveryRuns.sourceId, sourceId),
        isNotNull(discoveryRuns.finishedAt),
        isNull(discoveryRuns.error),
      ),
    )
    .limit(1)
    .get();
  return row !== undefined;
}

/**
 * The source's postings below the first-run cut (#215), in the order they are sent: the best
 * pre-filter match first (#218), as in listWaitingResultIds, then the newest posting, and those
 * with no date last. Sorted here because the date is inside the posting's JSON, and comes back as
 * text on both engines. A decided posting is not listed: it has nothing left to rank for.
 */
export async function listBelowCut(
  exec: Exec,
  ctx: UserCtx,
  sourceId: string,
): Promise<{ id: string; resolution: Resolution }[]> {
  const rows = await exec
    .select({
      id: discoveryResults.id,
      resolution: discoveryResults.resolution,
      outcome: discoveryResults.prefilterOutcome,
      score: discoveryResults.prefilterScore,
      postedAt: jsonText(discoveryResults.posting, 'postedAt'),
    })
    .from(discoveryResults)
    .innerJoin(discoveryRuns, eq(discoveryRuns.id, discoveryResults.runId))
    .where(
      and(
        eq(discoveryResults.userId, ctx.userId),
        eq(discoveryRuns.sourceId, sourceId),
        eq(discoveryResults.disposition, 'pending'),
        eq(discoveryResults.rankSkipReason, 'below_cut'),
      ),
    )
    .orderBy(asc(discoveryResults.createdAt), asc(discoveryResults.id))
    .all();
  const postedAt = (r: { postedAt: string | null }): number =>
    r.postedAt === null ? Number.NEGATIVE_INFINITY : Number(r.postedAt);
  const verdictRank = (r: { outcome: string | null }): number =>
    r.outcome === 'pass' ? 0 : r.outcome === 'filtered' ? 2 : 1;
  return rows
    .map((r, order) => ({ ...r, order, at: postedAt(r), rank: verdictRank(r), s: r.score ?? -1 }))
    .sort(
      (x, y) => x.rank - y.rank || y.s - x.s || (x.at === y.at ? x.order - y.order : y.at - x.at),
    )
    .map(({ id, resolution }) => ({ id, resolution }));
}

/**
 * The posting is on its way to ranking, so it no longer says the filter held it. Only that reason
 * goes, and only while it is pending: dismissed as it was sent, it needs the reason if Undo brings
 * it back. As clearBelowCut.
 */
export async function clearFiltered(exec: Exec, ctx: UserCtx, id: string): Promise<void> {
  await exec
    .update(discoveryResults)
    .set({ rankSkipReason: null })
    .where(
      and(
        ownedResult(ctx, id),
        eq(discoveryResults.disposition, 'pending'),
        eq(discoveryResults.rankSkipReason, 'filtered'),
      ),
    )
    .run();
}

/**
 * The posting is on its way to ranking, so it is no longer below the cut. Only that reason goes: a
 * job already queued may have written a newer one. Only while it is pending: dismissed as it was
 * sent, its job ends without ranking it, and it needs the reason if Undo brings it back.
 */
export async function clearBelowCut(exec: Exec, ctx: UserCtx, id: string): Promise<void> {
  await exec
    .update(discoveryResults)
    .set({ rankSkipReason: null })
    .where(
      and(
        ownedResult(ctx, id),
        eq(discoveryResults.disposition, 'pending'),
        eq(discoveryResults.rankSkipReason, 'below_cut'),
      ),
    )
    .run();
}

/** Stores a lead's resolution and, when resolved, the posting filled from the ATS. */
export async function setResolution(
  exec: Exec,
  ctx: UserCtx,
  id: string,
  update: { resolution: Resolution; resolvedSourceRef: string | null; posting?: NormalizedPosting },
): Promise<DiscoveryResultView> {
  await getResult(exec, ctx, id);
  await exec
    .update(discoveryResults)
    .set({
      resolution: update.resolution,
      resolvedSourceRef: update.resolvedSourceRef,
      ...(update.posting === undefined ? {} : { posting: update.posting }),
      updatedAt: Date.now(),
    })
    .where(ownedResult(ctx, id))
    .run();
  return await getResult(exec, ctx, id);
}
