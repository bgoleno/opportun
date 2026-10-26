// Profile (singleton per user), role targets and resume rules (FR-P1..P4).
import { and, eq } from 'drizzle-orm';
import { newId } from '@opportun/core';
import { profiles, resumeRules, roleTargets } from '../db/schema';
import { notFound } from '../lib/errors';
import type { Db, Exec, UserCtx } from './base';
import { countWhere, orderBy, sortColumns, type ListOpts, type Page } from './list';
import {
  createPromptVersion,
  getActivePrompt,
  getPromptVersion,
  linkProposalToRoleTarget,
  roleTargetProposal,
  type PromptVersion,
} from './prompts';
import { runCount, withTransaction } from '../db/client';

export type ProfileRow = typeof profiles.$inferSelect;
export type RoleTargetRow = typeof roleTargets.$inferSelect;
export type ResumeRuleRow = typeof resumeRules.$inferSelect;

type Writable<T> = Omit<T, 'id' | 'userId' | 'createdAt' | 'updatedAt'>;
export type ProfileInput = Writable<typeof profiles.$inferInsert>;
export type RoleTargetInput = Writable<typeof roleTargets.$inferInsert>;
export type ResumeRuleInput = Writable<typeof resumeRules.$inferInsert>;

// ---------------------------------------------------------------------------
// Profile

/** The caller's profile; created empty on first access so it always exists. */
export async function getProfile(db: Db, ctx: UserCtx): Promise<ProfileRow> {
  const now = Date.now();
  await db
    .insert(profiles)
    .values({ userId: ctx.userId, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();
  const row = await db.select().from(profiles).where(eq(profiles.userId, ctx.userId)).get();
  if (row === undefined) throw notFound();
  return row;
}

/** Full replace: every field not in `input` is reset to null (links to []). */
export async function putProfile(db: Db, ctx: UserCtx, input: ProfileInput): Promise<ProfileRow> {
  const now = Date.now();
  const values = {
    fullName: input.fullName ?? null,
    headline: input.headline ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    location: input.location ?? null,
    workAuth: input.workAuth ?? null,
    links: input.links ?? [],
  };
  await db
    .insert(profiles)
    .values({ userId: ctx.userId, ...values, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: profiles.userId, set: { ...values, updatedAt: now } })
    .run();
  return getProfile(db, ctx);
}

// ---------------------------------------------------------------------------
// Role targets

export const ROLE_TARGET_SORTS = sortColumns({
  name: roleTargets.name,
  createdAt: roleTargets.createdAt,
  updatedAt: roleTargets.updatedAt,
});

export async function listRoleTargets(
  db: Db,
  ctx: UserCtx,
  opts: ListOpts,
): Promise<Page<RoleTargetRow>> {
  const where = eq(roleTargets.userId, ctx.userId);
  const items = await db
    .select()
    .from(roleTargets)
    .where(where)
    .orderBy(...orderBy(opts.sort, 'createdAt', ROLE_TARGET_SORTS, roleTargets.id))
    .limit(opts.limit)
    .offset(opts.offset)
    .all();
  return { items, total: await countWhere(db, roleTargets, where) };
}

export async function getRoleTarget(db: Db, ctx: UserCtx, id: string): Promise<RoleTargetRow> {
  const row = await db
    .select()
    .from(roleTargets)
    .where(and(eq(roleTargets.userId, ctx.userId), eq(roleTargets.id, id)))
    .get();
  if (row === undefined) throw notFound();
  return row;
}

export async function createRoleTarget(
  db: Db,
  ctx: UserCtx,
  input: RoleTargetInput,
): Promise<RoleTargetRow> {
  const now = Date.now();
  const id = newId();
  await db
    .insert(roleTargets)
    .values({ ...input, id, userId: ctx.userId, createdAt: now, updatedAt: now })
    .run();
  return getRoleTarget(db, ctx, id);
}

export async function updateRoleTarget(
  db: Db,
  ctx: UserCtx,
  id: string,
  patch: Partial<RoleTargetInput>,
): Promise<RoleTargetRow> {
  const changes = await runCount(
    db
      .update(roleTargets)
      .set({ ...patch, updatedAt: Date.now() })
      .where(and(eq(roleTargets.userId, ctx.userId), eq(roleTargets.id, id))),
  );
  if (changes === 0) throw notFound();
  return getRoleTarget(db, ctx, id);
}

export async function deleteRoleTarget(db: Db, ctx: UserCtx, id: string): Promise<void> {
  const changes = await runCount(
    db.delete(roleTargets).where(and(eq(roleTargets.userId, ctx.userId), eq(roleTargets.id, id))),
  );
  if (changes === 0) throw notFound();
}

// ---------------------------------------------------------------------------
// Per-role-target discovery prompts (FR-P3, FR-D4). A role target uses the prompt its
// discovery_prompt_id names; null means the user's active discovery.rank prompt (the system
// seed unless they changed it). Creating a role target materializes nothing: the first edit
// from the role target creates a user version and links it. Linked versions are never marked
// active, so one target's prompt never changes another's or the user's default.

export const DISCOVERY_TASK = 'discovery.rank';

export interface RoleTargetDiscoveryPrompt {
  roleTargetId: string;
  /** The prompt ranking uses for this role target. */
  prompt: PromptVersion;
  /** True when the role target has its own linked version. */
  linked: boolean;
  /** A pending refinement proposal for this role target. */
  proposal: PromptVersion | null;
}

async function roleTargetSync(exec: Exec, ctx: UserCtx, id: string): Promise<RoleTargetRow> {
  const row = await exec
    .select()
    .from(roleTargets)
    .where(and(eq(roleTargets.userId, ctx.userId), eq(roleTargets.id, id)))
    .get();
  if (row === undefined) throw notFound();
  return row;
}

/** The discovery.rank prompt for a role target (null: no role target), with its link state. */
export async function resolveDiscoveryPrompt(
  db: Db,
  ctx: UserCtx,
  roleTarget: Pick<RoleTargetRow, 'discoveryPromptId'> | null,
): Promise<{ prompt: PromptVersion; linked: boolean } | undefined> {
  const linkedId = roleTarget?.discoveryPromptId ?? null;
  if (linkedId !== null) {
    const linked = await getPromptVersion(db, ctx, linkedId);
    if (linked !== undefined && linked.taskKey === DISCOVERY_TASK) {
      return { prompt: linked, linked: true };
    }
  }
  const active = await getActivePrompt(db, ctx, DISCOVERY_TASK);
  return active === undefined ? undefined : { prompt: active, linked: false };
}

export async function getRoleTargetDiscoveryPrompt(
  db: Db,
  ctx: UserCtx,
  roleTargetId: string,
): Promise<RoleTargetDiscoveryPrompt> {
  const target = await roleTargetSync(db, ctx, roleTargetId);
  const resolved = await resolveDiscoveryPrompt(db, ctx, target);
  if (resolved === undefined) throw notFound();
  return {
    roleTargetId,
    ...resolved,
    proposal: (await roleTargetProposal(db, ctx, roleTargetId)) ?? null,
  };
}

/** An edit from the role target: a new user version (parent: what it uses now), linked to it. */
export async function editRoleTargetDiscoveryPrompt(
  db: Db,
  ctx: UserCtx,
  roleTargetId: string,
  body: string,
): Promise<RoleTargetDiscoveryPrompt> {
  const current = await getRoleTargetDiscoveryPrompt(db, ctx, roleTargetId);
  const created = await createPromptVersion(db, ctx, DISCOVERY_TASK, body, undefined, {
    parentId: current.prompt.id,
  });
  await db
    .update(roleTargets)
    .set({ discoveryPromptId: created.id, updatedAt: Date.now() })
    .where(and(eq(roleTargets.userId, ctx.userId), eq(roleTargets.id, roleTargetId)))
    .run();
  return await getRoleTargetDiscoveryPrompt(db, ctx, roleTargetId);
}

/**
 * Points the role target at an existing discovery.rank version the caller can see (own or
 * system), or back to the default with null. Linking a pending proposal accepts it.
 */
export async function linkRoleTargetDiscoveryPrompt(
  db: Db,
  ctx: UserCtx,
  roleTargetId: string,
  promptId: string | null,
): Promise<RoleTargetDiscoveryPrompt> {
  await withTransaction(db, async (tx) => {
    await roleTargetSync(tx, ctx, roleTargetId);
    if (promptId === null) {
      await tx
        .update(roleTargets)
        .set({ discoveryPromptId: null, updatedAt: Date.now() })
        .where(and(eq(roleTargets.userId, ctx.userId), eq(roleTargets.id, roleTargetId)))
        .run();
      return;
    }
    const version = await getPromptVersion(tx, ctx, promptId);
    if (version === undefined || version.taskKey !== DISCOVERY_TASK) throw notFound();
    await linkProposalToRoleTarget(tx, ctx, promptId, roleTargetId);
  });
  return await getRoleTargetDiscoveryPrompt(db, ctx, roleTargetId);
}

// ---------------------------------------------------------------------------
// Resume rules

export const RESUME_RULE_SORTS = sortColumns({
  sortOrder: resumeRules.sortOrder,
  category: resumeRules.category,
  createdAt: resumeRules.createdAt,
  updatedAt: resumeRules.updatedAt,
});

export async function listResumeRules(
  db: Db,
  ctx: UserCtx,
  opts: ListOpts,
): Promise<Page<ResumeRuleRow>> {
  const where = eq(resumeRules.userId, ctx.userId);
  const items = await db
    .select()
    .from(resumeRules)
    .where(where)
    .orderBy(...orderBy(opts.sort, 'sortOrder', RESUME_RULE_SORTS, resumeRules.id))
    .limit(opts.limit)
    .offset(opts.offset)
    .all();
  return { items, total: await countWhere(db, resumeRules, where) };
}

export async function getResumeRule(db: Db, ctx: UserCtx, id: string): Promise<ResumeRuleRow> {
  const row = await db
    .select()
    .from(resumeRules)
    .where(and(eq(resumeRules.userId, ctx.userId), eq(resumeRules.id, id)))
    .get();
  if (row === undefined) throw notFound();
  return row;
}

export async function createResumeRule(
  db: Db,
  ctx: UserCtx,
  input: ResumeRuleInput,
): Promise<ResumeRuleRow> {
  const now = Date.now();
  const id = newId();
  await db
    .insert(resumeRules)
    .values({ ...input, id, userId: ctx.userId, createdAt: now, updatedAt: now })
    .run();
  return getResumeRule(db, ctx, id);
}

export async function updateResumeRule(
  db: Db,
  ctx: UserCtx,
  id: string,
  patch: Partial<ResumeRuleInput>,
): Promise<ResumeRuleRow> {
  const changes = await runCount(
    db
      .update(resumeRules)
      .set({ ...patch, updatedAt: Date.now() })
      .where(and(eq(resumeRules.userId, ctx.userId), eq(resumeRules.id, id))),
  );
  if (changes === 0) throw notFound();
  return getResumeRule(db, ctx, id);
}

export async function deleteResumeRule(db: Db, ctx: UserCtx, id: string): Promise<void> {
  const changes = await runCount(
    db.delete(resumeRules).where(and(eq(resumeRules.userId, ctx.userId), eq(resumeRules.id, id))),
  );
  if (changes === 0) throw notFound();
}
