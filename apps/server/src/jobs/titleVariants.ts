// Title variants for the discovery pre-filter (https://github.com/bgoleno/opportun/issues/217,
// tl's proposal 4.4 on #190): one AI call per role target, when it is created or its name or
// title family changes, lists 20 to 40 job titles that mean the same work. The user can edit the
// list. The pre-filter (lib/prefilter.ts) matches posting titles against it.
//
// What the call sends: the role target's own fields that say what the job is called (its name,
// title family, seniority range and keywords). No posting, resume, contact or company data.
import {
  AiUnavailableError,
  renderPrompt,
  runStructured,
  TitleVariantsOutputSchema,
} from '@opportun/ai';
import { seniorityRangeText } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
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
 * Makes and stores one role target's variants. The list is written only while the target still
 * has the name and title family the call was made for, so a rename that lands meanwhile is not
 * overwritten with titles for the old one (its own job makes the new list).
 */
export async function makeTitleVariants(
  db: Db,
  ctx: UserCtx,
  roleTargetId: string,
): Promise<TitleVariantsRun> {
  const target = await db
    .select()
    .from(roleTargets)
    .where(and(eq(roleTargets.userId, ctx.userId), eq(roleTargets.id, roleTargetId)))
    .get();
  if (target === undefined) return { status: 'skipped', reason: 'missing' };
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
    // No key, over budget, or the provider is down: the list stays as it was. The pre-filter
    // still matches the target's name and title family.
    if (err instanceof AiUnavailableError) return { status: 'skipped', reason: err.reason };
    throw err;
  }
  const titles = cleanTitleVariants(out.titles);
  await db
    .update(roleTargets)
    .set({ titleVariants: titles, updatedAt: Date.now() })
    .where(
      and(
        eq(roleTargets.userId, ctx.userId),
        eq(roleTargets.id, roleTargetId),
        eq(roleTargets.name, target.name),
        eq(roleTargets.titleFamily, target.titleFamily),
      ),
    )
    .run();
  return { status: 'made', count: titles.length };
}

/** Queues the one call for a target (a second request while one is pending adds nothing). */
export async function queueTitleVariants(
  db: Db,
  ctx: UserCtx,
  roleTargetId: string,
): Promise<void> {
  await enqueue(
    db,
    TITLE_VARIANTS_KIND,
    { roleTargetId },
    { dedupeKey: `${TITLE_VARIANTS_KIND}:${roleTargetId}`, userId: ctx.userId },
  );
}

const PayloadSchema = z.object({ roleTargetId: z.string().min(1).max(64) });

export const titleVariantsJob: JobHandler<z.infer<typeof PayloadSchema>> = {
  kind: TITLE_VARIANTS_KIND,
  payloadSchema: PayloadSchema,
  maxAttempts: 3,
  async run(db, payload, ctx) {
    if (ctx.userId === null) throw new Error(`${TITLE_VARIANTS_KIND} needs a user`);
    await ctx.setResult(
      await makeTitleVariants(db, { userId: ctx.userId, isAdmin: false }, payload.roleTargetId),
    );
  },
};
