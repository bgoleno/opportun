// Discovery sources, runs and results (FR-D1..D3). Every function is scoped to the caller: a
// source, run or result of another user is a 404, and a reference (role target, company,
// source, run) must be the caller's own.
import { newId, type Disposition, type NormalizedPosting, type Resolution } from '@opportun/core';
import { and, asc, count, eq, getTableColumns, inArray, type SQL } from 'drizzle-orm';
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
import { likePrefix } from '../db/dialect';
import { HttpError, notFound } from '../lib/errors';
import { DISCOVERY_RUN_KIND } from '../jobs/discoveryKinds';
import { removeSchedule, setSchedule, userCronProblem } from '../jobs/runner';
import type { Db, Exec, UserCtx } from './base';
import { getOpportunity } from './opportunities';
import { countWhere, orderBy, sortColumns, type ListOpts, type Page } from './list';
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
  /** The message this lead was parsed out of, for a channel that delivers postings by mail. */
  sourceCommunicationId?: string | null | undefined;
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
      sourceCommunicationId: input.sourceCommunicationId ?? null,
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
  await exec
    .update(discoveryResults)
    .set({ ...ranking, updatedAt: Date.now() })
    .where(ownedResult(ctx, id))
    .run();
  return await getResult(exec, ctx, id);
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
