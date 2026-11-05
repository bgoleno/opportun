// Title variants for the discovery pre-filter (https://github.com/bgoleno/opportun/issues/217,
// tl's proposal 4.4 on #190): one AI call per role target, when it is created or its name or
// title family changes, lists 20 to 40 job titles that mean the same work. The user can edit the
// list, and what they save wins. A target whose call could not run, or from before this feature,
// is picked up by a nightly sweep and when an AI key is added. The pre-filter (lib/prefilter.ts)
// matches posting titles against the list.
//
// What the call sends: the role target's own fields that say what the job is called (its name,
// title family, seniority range and keywords). No posting, resume, contact or company data.
import {
  AiUnavailableError,
  renderPrompt,
  runStructured,
  TitleVariantsOutputSchema,
} from '@opportun/ai';
import { createHash } from 'node:crypto';
import { seniorityRangeText } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { runCount, type Db } from '../db/client';
import { roleTargets } from '../db/schema';
import { buildAiDeps } from '../lib/ai';
import { line } from '../lib/promptText';
import type { UserCtx } from '../repos/base';
import { getActivePrompt } from '../repos/prompts';
import type { JobHandler } from './registry';
import { enqueue } from './runner';

export const TITLE_VARIANTS_KIND = 'discovery.title_variants';

/** The most variants a role target keeps (tl: 20 to 40); the user may keep fewer. */
export const MAX_TITLE_VARIANTS = 40;
const MAX_TITLE_CHARS = 200;

/**
 * A variant list as stored: each title on one line with single spaces and no control characters,
 * at most 200 characters, duplicates (ignoring case) dropped, at most 40, in the given order.
 */
export function cleanTitleVariants(titles: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of titles) {
    const title = raw
      .replace(/\p{Cc}/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_TITLE_CHARS)
      .trim();
    const key = title.toLowerCase();
    if (title === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(title);
    if (out.length === MAX_TITLE_VARIANTS) break;
  }
  return out;
}

type RoleTargetRow = typeof roleTargets.$inferSelect;

/** What the call is told about the target: what the job is called, and nothing else. */
export function titleTargetText(t: RoleTargetRow): string {
  const parts = [`${line(t.name)}: ${line(t.titleFamily)}`];
  parts.push(`seniority ${seniorityRangeText(t.seniorityMin, t.seniorityMax)}`);
  if (t.keywords.length > 0)
    parts.push(`keywords ${t.keywords.map((k) => line(k, 60)).join(', ')}`);
  return `- ${parts.join('; ')}`;
}

export type TitleVariantsRun =
  { status: 'made'; count: number } | { status: 'skipped'; reason: string };

/**
 * Which title a call is for: the target's name and title family, hashed so that neither sits in
 * the jobs table. It is in the job's dedupe key, because that key's index also covers a running
 * job: without it, a rename during a call would be folded into the very call it makes stale, and
 * the target would end with no list.
 */
export const titleKeyOf = (t: { name: string; titleFamily: string }): string =>
  createHash('sha256')
    .update(JSON.stringify([t.name, t.titleFamily]))
    .digest('hex')
    .slice(0, 16);

/**
 * Makes and stores one role target's variants, if it still wants them for this title. A job that
 * waited makes no call once the user has saved their own list or renamed the target. The write
 * checks the same two things again, because either can land during the call: the user's list
 * wins, and titles for the old name never reach the new one (that rename queued its own job).
 */
export async function makeTitleVariants(
  db: Db,
  ctx: UserCtx,
  roleTargetId: string,
  titleKey: string,
): Promise<TitleVariantsRun> {
  const target = await db
    .select()
    .from(roleTargets)
    .where(and(eq(roleTargets.userId, ctx.userId), eq(roleTargets.id, roleTargetId)))
    .get();
  if (target === undefined) return { status: 'skipped', reason: 'missing' };
  if (titleKeyOf(target) !== titleKey) return { status: 'skipped', reason: 'renamed' };
  if (!target.titleVariantsNeeded) return { status: 'skipped', reason: 'user_list' };
  const prompt = await getActivePrompt(db, ctx, TITLE_VARIANTS_KIND);
  if (prompt === undefined) return { status: 'skipped', reason: 'no_prompt' };
  let out: z.infer<typeof TitleVariantsOutputSchema>;
  try {
    out = await runStructured(await buildAiDeps(db, ctx), TITLE_VARIANTS_KIND, {
      system: renderPrompt(prompt.body, { role_target: titleTargetText(target) }),
      prompt: 'List the equivalent job titles and return the result.',
      schema: TitleVariantsOutputSchema,
      promptId: prompt.id,
    });
  } catch (err) {
    // A provider that is down is worth this job's own retries; the error text is sanitized by the
    // router. No key, over budget, or a bad answer: the list stays as it was, the target still
    // wants one, and the sweep tries again. The pre-filter still matches the name and title family.
    if (err instanceof AiUnavailableError && err.reason !== 'provider_error') {
      return { status: 'skipped', reason: err.reason };
    }
    throw err;
  }
  const titles = cleanTitleVariants(out.titles);
  // An empty answer says nothing: it must not replace a good list.
  if (titles.length === 0) return { status: 'skipped', reason: 'empty_answer' };
  const written = await runCount(
    db
      .update(roleTargets)
      .set({ titleVariants: titles, titleVariantsNeeded: false, updatedAt: Date.now() })
      .where(
        and(
          eq(roleTargets.userId, ctx.userId),
          eq(roleTargets.id, roleTargetId),
          eq(roleTargets.name, target.name),
          eq(roleTargets.titleFamily, target.titleFamily),
          eq(roleTargets.titleVariantsNeeded, true),
        ),
      ),
  );
  if (written === 0) return { status: 'skipped', reason: 'changed_during_call' };
  return { status: 'made', count: titles.length };
}

/** Queues the one call for a target's current title (a second request adds nothing meanwhile). */
export async function queueTitleVariants(
  db: Db,
  ctx: UserCtx,
  target: { id: string; name: string; titleFamily: string },
): Promise<void> {
  const titleKey = titleKeyOf(target);
  await enqueue(
    db,
    TITLE_VARIANTS_KIND,
    { roleTargetId: target.id, titleKey },
    { dedupeKey: `${TITLE_VARIANTS_KIND}:${target.id}:${titleKey}`, userId: ctx.userId },
  );
}

/**
 * Whether a call could get past the key check. The nightly sweep asks first, so that an instance
 * with no AI key set up does not record a failed call per target per night. Adding a key sweeps.
 */
async function hasTitleVariantsKey(db: Db, ctx: UserCtx): Promise<boolean> {
  const deps = await buildAiDeps(db, ctx);
  const policy = await deps.policyFor(TITLE_VARIANTS_KIND);
  try {
    await deps.getKey(policy.provider);
    return true;
  } catch {
    return false;
  }
}

/**
 * Queues a call for each of the user's active targets that still wants a list: one from before
 * this feature, or whose call found no key, no budget or a bad answer. A target whose list the
 * user saved or cleared does not want one, so it is not refilled. Returns how many were queued.
 */
export async function sweepTitleVariantsFor(db: Db, ctx: UserCtx): Promise<number> {
  const wanting = await db
    .select({ id: roleTargets.id, name: roleTargets.name, titleFamily: roleTargets.titleFamily })
    .from(roleTargets)
    .where(
      and(
        eq(roleTargets.userId, ctx.userId),
        eq(roleTargets.active, true),
        eq(roleTargets.titleVariantsNeeded, true),
      ),
    )
    .all();
  for (const target of wanting) await queueTitleVariants(db, ctx, target);
  return wanting.length;
}

/** Every user with a target still wanting a list, skipping those with no key to make it with. */
export async function sweepTitleVariants(db: Db): Promise<number> {
  const owners = await db
    .selectDistinct({ userId: roleTargets.userId })
    .from(roleTargets)
    .where(and(eq(roleTargets.active, true), eq(roleTargets.titleVariantsNeeded, true)))
    .all();
  let queued = 0;
  for (const { userId } of owners) {
    const ctx: UserCtx = { userId, isAdmin: false };
    if (await hasTitleVariantsKey(db, ctx)) queued += await sweepTitleVariantsFor(db, ctx);
  }
  return queued;
}

const PayloadSchema = z.object({
  roleTargetId: z.string().min(1).max(64),
  titleKey: z.string().min(1).max(64),
});

export const titleVariantsJob: JobHandler<z.infer<typeof PayloadSchema>> = {
  kind: TITLE_VARIANTS_KIND,
  payloadSchema: PayloadSchema,
  maxAttempts: 3,
  async run(db, payload, ctx) {
    if (ctx.userId === null) throw new Error(`${TITLE_VARIANTS_KIND} needs a user`);
    await ctx.setResult(
      await makeTitleVariants(
        db,
        { userId: ctx.userId, isAdmin: false },
        payload.roleTargetId,
        payload.titleKey,
      ),
    );
  },
};

export const TITLE_VARIANTS_SWEEP_KIND = 'discovery.title_variants_sweep';
/** Nightly, after the backup and the job prune, and before the morning's discovery runs. */
export const TITLE_VARIANTS_SWEEP_CRON = '30 5 * * *';

export const titleVariantsSweepJob: JobHandler<Record<string, never>> = {
  kind: TITLE_VARIANTS_SWEEP_KIND,
  payloadSchema: z.object({}).strict(),
  maxAttempts: 2,
  async run(db, _payload, ctx) {
    // Counts only: no target names leave the database this way.
    await ctx.setResult({ queued: await sweepTitleVariants(db) });
  },
};
