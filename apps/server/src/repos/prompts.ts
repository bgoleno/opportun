// Versioned prompt store (FR-A4). System defaults (user_id NULL, seeded by migration 0002)
// are shared and never modified. An edit creates a user-owned version n+1 whose parent is the
// caller's active version. Which version is active is per user: the caller's own active row
// when one exists, otherwise the active system default. "Reset to default" is activating the
// system row, which deactivates the caller's own versions and leaves other users untouched.
import { newId } from '@opportun/core';
import { and, asc, desc, eq, isNull, like, or, type SQL } from 'drizzle-orm';
import { prompts, roleTargets, settings } from '../db/schema';
import { notFound } from '../lib/errors';
import type { Db, Exec, UserCtx } from './base';
import { lockScope, runCount, withTransaction } from '../db/client';
import { racePoint } from '../lib/racePoints';

type PromptRow = typeof prompts.$inferSelect;

export interface PromptVersion {
  id: string;
  taskKey: string;
  name: string;
  body: string;
  version: number;
  parentId: string | null;
  /** Active for the caller (system rows are active only when the caller has no own active row). */
  isActive: boolean;
  /** A shared system default (read-only). */
  isSystem: boolean;
  /** A proposed refinement awaiting the user's accept or discard (never active). */
  proposed: boolean;
  proposalSummary: string | null;
  createdAt: number;
}

/** Rows the caller may read: system defaults plus their own versions. */
function visible(ctx: UserCtx): SQL {
  return or(isNull(prompts.userId), eq(prompts.userId, ctx.userId)) as SQL;
}

async function visibleRows(exec: Exec, ctx: UserCtx, taskKey?: string): Promise<PromptRow[]> {
  const where =
    taskKey === undefined ? visible(ctx) : and(visible(ctx), eq(prompts.taskKey, taskKey));
  return await exec
    .select()
    .from(prompts)
    .where(where)
    .orderBy(asc(prompts.taskKey), desc(prompts.version))
    .all();
}

/** The caller's active row per task among `rows` (own active row wins over the system one). */
function activeIds(rows: PromptRow[]): Set<string> {
  const own = new Map<string, string>();
  const system = new Map<string, string>();
  for (const r of rows) {
    if (!r.isActive) continue;
    (r.userId === null ? system : own).set(r.taskKey, r.id);
  }
  const ids = new Set<string>();
  for (const [task, id] of system) if (!own.has(task)) ids.add(id);
  for (const id of own.values()) ids.add(id);
  return ids;
}

function toView(r: PromptRow, active: Set<string>): PromptVersion {
  return {
    id: r.id,
    taskKey: r.taskKey,
    name: r.name,
    body: r.body,
    version: r.version,
    parentId: r.parentId,
    isActive: active.has(r.id),
    isSystem: r.userId === null,
    proposed: r.proposed,
    proposalSummary: r.proposalSummary,
    createdAt: r.createdAt,
  };
}

/** Every version the caller can see (newest first within each task). */
export async function listPromptVersions(
  db: Db,
  ctx: UserCtx,
  taskKey?: string,
): Promise<PromptVersion[]> {
  const rows = await visibleRows(db, ctx, taskKey);
  const active = activeIds(rows);
  return rows.map((r) => toView(r, active));
}

async function activeSync(
  exec: Exec,
  ctx: UserCtx,
  taskKey: string,
): Promise<PromptVersion | undefined> {
  const rows = await visibleRows(exec, ctx, taskKey);
  const active = activeIds(rows);
  const row = rows.find((r) => active.has(r.id));
  return row === undefined ? undefined : toView(row, active);
}

/** The prompt the caller's AI calls use for a task, or undefined when none is seeded. */
export async function getActivePrompt(
  db: Db,
  ctx: UserCtx,
  taskKey: string,
): Promise<PromptVersion | undefined> {
  return await activeSync(db, ctx, taskKey);
}

/** A version the caller can see (own or system), or undefined. */
export async function getPromptVersion(
  exec: Exec,
  ctx: UserCtx,
  id: string,
): Promise<PromptVersion | undefined> {
  const row = await exec
    .select()
    .from(prompts)
    .where(and(eq(prompts.id, id), visible(ctx)))
    .get();
  if (row === undefined) return undefined;
  const active = activeIds(await visibleRows(exec, ctx, row.taskKey));
  return toView(row, active);
}

/**
 * Saves an edit as a new inactive user-owned version: version n+1, parent = active version
 * (or `parentId`, for a version derived from a role target's own prompt).
 */
export async function createPromptVersion(
  db: Db,
  ctx: UserCtx,
  taskKey: string,
  body: string,
  proposal?: { summary: string },
  opts: { parentId?: string } = {},
): Promise<PromptVersion> {
  await racePoint('prompts.create');
  return await withTransaction(db, async (tx) => {
    // max(version) + 1 has no lock of its own: serialize the caller's prompt writes.
    await lockScope(tx, `user:${ctx.userId}`);
    const rows = await visibleRows(tx, ctx, taskKey);
    const parent =
      opts.parentId === undefined
        ? await activeSync(tx, ctx, taskKey)
        : rows.find((r) => r.id === opts.parentId);
    const version = rows.reduce((max, r) => Math.max(max, r.version), 0) + 1;
    await racePoint('prompts.create.locked');
    const now = Date.now();
    const row = await tx
      .insert(prompts)
      .values({
        id: newId(),
        userId: ctx.userId,
        taskKey,
        name: parent?.name ?? 'default',
        body,
        version,
        parentId: parent?.id ?? null,
        isActive: false,
        proposed: proposal !== undefined,
        proposalSummary: proposal?.summary ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return toView(row, new Set());
  });
}

/**
 * Makes a version the caller's active one. Activating a system default is the reset: it only
 * deactivates the caller's own versions of that task. 404 for rows the caller cannot see.
 */
export async function activatePrompt(db: Db, ctx: UserCtx, id: string): Promise<PromptVersion> {
  await racePoint('prompts.activate');
  return await withTransaction(db, async (tx) => {
    // Deactivate-all-then-activate: two activations interleaved would leave two active.
    await lockScope(tx, `user:${ctx.userId}`);
    const target = await tx
      .select()
      .from(prompts)
      .where(and(eq(prompts.id, id), visible(ctx)))
      .get();
    if (target === undefined) throw notFound();
    await racePoint('prompts.activate.locked');
    const now = Date.now();
    await tx
      .update(prompts)
      .set({ isActive: false, updatedAt: now })
      .where(
        and(
          eq(prompts.userId, ctx.userId),
          eq(prompts.taskKey, target.taskKey),
          eq(prompts.isActive, true),
        ),
      )
      .run();
    if (target.userId !== null) {
      // Activating a proposed refinement is the user's accept: it stops being a proposal.
      await tx
        .update(prompts)
        .set({ isActive: true, proposed: false, updatedAt: now })
        .where(and(eq(prompts.id, target.id), eq(prompts.userId, ctx.userId)))
        .run();
    }
    const view = await activeSync(tx, ctx, target.taskKey);
    if (view?.id !== target.id) throw notFound();
    return view;
  });
}

// ---------------------------------------------------------------------------
// Proposed refinements (FR-D6 pattern applied to FR-M8)

async function ownProposal(exec: Exec, ctx: UserCtx, id: string): Promise<PromptRow> {
  const row = await exec
    .select()
    .from(prompts)
    .where(and(eq(prompts.id, id), eq(prompts.userId, ctx.userId), eq(prompts.proposed, true)))
    .get();
  if (row === undefined) throw notFound();
  return row;
}

/**
 * Stores a proposed refinement as an inactive, flagged version. An older proposal for the task
 * that was never accepted is superseded (deleted). Nothing is activated.
 */
export async function createProposedVersion(
  db: Db,
  ctx: UserCtx,
  taskKey: string,
  body: string,
  summary: string,
): Promise<PromptVersion> {
  await discardPendingProposals(db, ctx, taskKey);
  return await createPromptVersion(db, ctx, taskKey, body, { summary });
}

async function discardPendingProposals(db: Db, ctx: UserCtx, taskKey: string): Promise<void> {
  await db
    .delete(prompts)
    .where(
      and(
        eq(prompts.userId, ctx.userId),
        eq(prompts.taskKey, taskKey),
        eq(prompts.proposed, true),
        eq(prompts.isActive, false),
      ),
    )
    .run();
}

/** The caller's pending proposals, newest first. */
export async function listProposals(
  db: Db,
  ctx: UserCtx,
  taskKey?: string,
): Promise<PromptVersion[]> {
  return (await listPromptVersions(db, ctx, taskKey)).filter((v) => v.proposed);
}

/**
 * Accept: activates the proposal (which clears its flag). A proposal made for one role target's
 * discovery prompt is linked to that role target instead, so other targets and the user's
 * default stay as they were. 404 unless it is the caller's.
 */
export async function acceptProposal(db: Db, ctx: UserCtx, id: string): Promise<PromptVersion> {
  await ownProposal(db, ctx, id);
  const roleTargetId = await roleTargetOfProposal(db, ctx, id);
  if (roleTargetId === null) return await activatePrompt(db, ctx, id);
  return await withTransaction(db, async (tx) => {
    await linkProposalToRoleTarget(tx, ctx, id, roleTargetId);
    const view = await getPromptVersion(tx, ctx, id);
    if (view === undefined) throw notFound();
    return view;
  });
}

/** Discard: deletes the proposal. 404 unless it is the caller's pending proposal. */
export async function discardProposal(db: Db, ctx: UserCtx, id: string): Promise<void> {
  await withTransaction(db, async (tx) => {
    await ownProposal(tx, ctx, id);
    await tx
      .delete(prompts)
      .where(and(eq(prompts.id, id), eq(prompts.userId, ctx.userId), eq(prompts.proposed, true)))
      .run();
    await dropProposalPointer(tx, ctx, id);
  });
}

// ---------------------------------------------------------------------------
// Role target discovery proposals (FR-D6 discovery variant). A proposal for one role target's
// discovery.rank prompt is an ordinary proposed version plus a pointer row
// `discovery_proposal:<promptId>` (value: the role target id, user_id set for cascade).

const proposalPointerKey = (promptId: string): string => `discovery_proposal:${promptId}`;

/** The role target a pending discovery proposal belongs to, or null for an ordinary proposal. */
export async function roleTargetOfProposal(
  exec: Exec,
  ctx: UserCtx,
  promptId: string,
): Promise<string | null> {
  const value = (
    await exec
      .select({ value: settings.value })
      .from(settings)
      .where(and(eq(settings.key, proposalPointerKey(promptId)), eq(settings.userId, ctx.userId)))
      .get()
  )?.value;
  return typeof value === 'string' ? value : null;
}

async function dropProposalPointer(exec: Exec, ctx: UserCtx, promptId: string): Promise<void> {
  await exec
    .delete(settings)
    .where(and(eq(settings.key, proposalPointerKey(promptId)), eq(settings.userId, ctx.userId)))
    .run();
}

/** The caller's pending proposal for a role target, if any. */
export async function roleTargetProposal(
  exec: Exec,
  ctx: UserCtx,
  roleTargetId: string,
): Promise<PromptVersion | undefined> {
  const pointers = (
    await exec
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(and(eq(settings.userId, ctx.userId), like(settings.key, 'discovery_proposal:%')))
      .all()
  ).filter((p) => p.value === roleTargetId);
  for (const p of pointers) {
    const view = await getPromptVersion(exec, ctx, p.key.slice('discovery_proposal:'.length));
    if (view?.proposed === true) return view;
  }
  return undefined;
}

/**
 * Links an accepted proposal (or any visible discovery.rank version) to the role target and
 * clears its proposal state. Nothing becomes globally active.
 */
export async function linkProposalToRoleTarget(
  exec: Exec,
  ctx: UserCtx,
  promptId: string,
  roleTargetId: string,
): Promise<void> {
  const now = Date.now();
  await exec
    .update(prompts)
    .set({ proposed: false, updatedAt: now })
    .where(and(eq(prompts.id, promptId), eq(prompts.userId, ctx.userId)))
    .run();
  const changes = await runCount(
    exec
      .update(roleTargets)
      .set({ discoveryPromptId: promptId, updatedAt: now })
      .where(and(eq(roleTargets.userId, ctx.userId), eq(roleTargets.id, roleTargetId))),
  );
  if (changes === 0) throw notFound();
  await dropProposalPointer(exec, ctx, promptId);
}

/**
 * Stores a proposed refinement of one role target's discovery prompt: an inactive, flagged
 * version whose parent is the prompt the target uses now. An earlier unaccepted proposal for
 * the same role target is superseded (deleted). Nothing is activated or linked.
 */
export async function createRoleTargetProposal(
  db: Db,
  ctx: UserCtx,
  roleTargetId: string,
  parentId: string,
  body: string,
  summary: string,
): Promise<PromptVersion> {
  const previous = await roleTargetProposal(db, ctx, roleTargetId);
  if (previous !== undefined) await discardProposal(db, ctx, previous.id);
  const created = await createPromptVersion(
    db,
    ctx,
    'discovery.rank',
    body,
    { summary },
    { parentId },
  );
  await db
    .insert(settings)
    .values({
      key: proposalPointerKey(created.id),
      userId: ctx.userId,
      value: roleTargetId,
      updatedAt: Date.now(),
    })
    .run();
  return created;
}
