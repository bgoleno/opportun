// Profile (singleton per user), role targets and resume rules (FR-P1..P4).
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  applicationDetailField,
  detailValuePasses,
  newId,
  PROFILE_DETAIL_KEYS,
  type ApplicationDetailKey,
} from '@opportun/core';
import { profiles, resumeRules, roleTargets } from '../db/schema';
import { audit } from '../lib/audit';
import { HttpError, notFound } from '../lib/errors';
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
import { lockScope, runCount, withTransaction } from '../db/client';

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
export async function getProfile(db: Exec, ctx: UserCtx): Promise<ProfileRow> {
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

/**
 * The longest text each profile column holds, and the profile's email rule: PUT /profile's own
 * rules (routes/profile.ts builds its body from these), so a value saved from an application
 * (#411) passes the same ones and GET /profile never serves what its schema refuses.
 */
export const PROFILE_TEXT_MAX = {
  fullName: 200,
  headline: 300,
  phone: 50,
  location: 200,
  workAuth: 200,
} as const;
export const ProfileEmail = z.email().max(254);

/** The profile's columns, in the order an audit record names them. */
const PROFILE_COLUMNS = [
  'fullName',
  'headline',
  'email',
  'phone',
  'location',
  'workAuth',
  'links',
] as const;
type ProfileColumn = (typeof PROFILE_COLUMNS)[number];
type ProfileValues = Pick<ProfileRow, ProfileColumn | 'applicationDetails'>;

/** Who changed the profile, for its audit record: Settings > Profile, or an application. */
export type ProfileChangeVia = 'settings' | 'application';

/**
 * The names of the fields `next` changes, in a fixed order: the columns, then each detail as
 * `applicationDetails.<key>` in the shared list's order. Names only, always code constants (the
 * details' keys are the list's, ApplicationDetailsSchema), never a value.
 */
function changedFields(before: ProfileValues, next: ProfileValues): string[] {
  const wasRow = new Map<string, unknown>(Object.entries(before));
  const nowRow = new Map<string, unknown>(Object.entries(next));
  const names: string[] = PROFILE_COLUMNS.filter(
    (c) => JSON.stringify(wasRow.get(c)) !== JSON.stringify(nowRow.get(c)),
  );
  const was = new Map(Object.entries(before.applicationDetails));
  const now = new Map(Object.entries(next.applicationDetails));
  for (const key of PROFILE_DETAIL_KEYS) {
    if (was.get(key) !== now.get(key)) names.push(`applicationDetails.${key}`);
  }
  return names;
}

/**
 * Writes the caller's profile as `change` says, under the profile's own lock (a caller that
 * holds an attempt's lock takes it first: repos/submissions.ts), and records which fields
 * changed, by name, in one `profile.updated` audit record (`changed`). Writes and records nothing when
 * nothing would change. `exec` is the caller's transaction.
 */
async function changeProfile(
  exec: Exec,
  ctx: UserCtx,
  change: (current: ProfileValues) => ProfileValues,
  via: ProfileChangeVia,
): Promise<void> {
  await lockScope(exec, `profile:${ctx.userId}`);
  const current = await getProfile(exec, ctx);
  const next = change(current);
  const fields = changedFields(current, next);
  if (fields.length === 0) return;
  await exec
    .update(profiles)
    .set({ ...next, updatedAt: Date.now() })
    .where(eq(profiles.userId, ctx.userId))
    .run();
  // `changed`, not `fields`: the audit log redacts a `fields` key (lib/audit.ts), because a
  // submission's fields hold values; this one holds names only.
  await audit(exec, 'profile.updated', { userId: ctx.userId, detail: { via, changed: fields } });
}

/**
 * Full replace of the columns: every one not in `input` is reset to null (links to []). The
 * application details are the exception: omitted, they stay as they are (#411, tl), because a
 * client that does not show them (Settings before #401's slice 2) would otherwise wipe them on
 * every save. Sent, they replace the stored ones.
 */
export async function putProfile(
  db: Db,
  ctx: UserCtx,
  input: Partial<ProfileInput>,
): Promise<ProfileRow> {
  await withTransaction(db, (tx) =>
    changeProfile(
      tx,
      ctx,
      (current) => ({
        fullName: input.fullName ?? null,
        headline: input.headline ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        location: input.location ?? null,
        workAuth: input.workAuth ?? null,
        links: input.links ?? [],
        applicationDetails: input.applicationDetails ?? current.applicationDetails,
      }),
      'settings',
    ),
  );
  return getProfile(db, ctx);
}

const PROFILE_VALUE_MESSAGE = 'That value cannot be saved to your profile.';

/**
 * Whether `value` may be saved as detail `key` in the profile: today's draft check, then, for a
 * detail that lives in a column, that column's own rule. Null when it may.
 */
function profileValueProblem(key: ApplicationDetailKey, value: string): string | null {
  if (!detailValuePasses(key, value)) return 'profile_value_invalid';
  const { home } = applicationDetailField(key);
  if (home === 'details') return null;
  if (home === 'email')
    return ProfileEmail.safeParse(value).success ? null : 'profile_value_invalid';
  const max = new Map<string, number>(Object.entries(PROFILE_TEXT_MAX)).get(home) ?? 0;
  return [...value].length <= max ? null : 'profile_value_invalid';
}

/**
 * Saves these detail fields of a draft to the caller's profile (#411): each takes the draft's
 * value, trimmed, and an empty one removes the profile's (the column to null, the detail's key
 * dropped). Checks every value before writing any, and refuses the lot with a 422 that names the
 * field, never its value. Runs inside the caller's transaction, after the attempt's lock.
 */
export async function saveDetailsToProfile(
  exec: Exec,
  ctx: UserCtx,
  fields: Readonly<Record<string, string>>,
  keys: readonly ApplicationDetailKey[],
): Promise<void> {
  const values = new Map(Object.entries(fields));
  const saved = new Map<ApplicationDetailKey, string>();
  for (const key of new Set(keys)) {
    const value = (values.get(key) ?? '').trim();
    const problem = value === '' ? null : profileValueProblem(key, value);
    if (problem !== null) throw new HttpError(422, problem, PROFILE_VALUE_MESSAGE, { field: key });
    saved.set(key, value);
  }
  if (saved.size === 0) return;
  await changeProfile(
    exec,
    ctx,
    (current) => {
      const next: ProfileValues = {
        ...current,
        applicationDetails: { ...current.applicationDetails },
      };
      const details = new Map(Object.entries(next.applicationDetails));
      for (const [key, value] of saved) {
        const { home } = applicationDetailField(key);
        if (home === 'details') {
          if (value === '') details.delete(key);
          else details.set(key, value);
        } else {
          Object.assign(next, { [home]: value === '' ? null : value });
        }
      }
      next.applicationDetails = Object.fromEntries(details);
      return next;
    },
    'application',
  );
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
