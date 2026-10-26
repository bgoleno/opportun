// discovery.rank job (FR-D4, FR-P3). Scores one pending result against the role target its
// source runs for, with that role target's discovery prompt (its linked version, else the
// user's active one, which is the system seed unless they changed it). The posting is passed as
// posting_untrusted, so renderPrompt fences it. Without AI the result stays pending, unranked:
// the user triages it by hand (manual path).
import {
  AiUnavailableError,
  RankOutputSchema as AiRankOutputSchema,
  renderPrompt,
  runStructured,
} from '@opportun/ai';
import type { NormalizedPosting } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { roleTargets } from '../db/schema';
import { buildAiDeps } from '../lib/ai';
import { HttpError } from '../lib/errors';
import type { UserCtx } from '../repos/base';
import { getResult, setRanking, type DiscoveryResultView } from '../repos/discovery';
import { resolveDiscoveryPrompt } from '../repos/profile';
import { roleTargetLine, roleTargetsText } from './classify';
import { DISCOVERY_RANK_KIND, MULTI_POSTED_PREFIX, MULTI_POSTED_SCORE_CAP } from './discoveryKinds';
import type { JobHandler } from './registry';

export { DISCOVERY_RANK_KIND };

/** {score 0-100, rationale, disqualifiers}; defined once in @opportun/ai (the router validates). */
export const RankOutputSchema = AiRankOutputSchema;
export type RankOutput = z.infer<typeof RankOutputSchema>;

const MAX_DESCRIPTION_CHARS = 20_000;
const MAX_RATIONALE_CHARS = 2000;

/** The sanitized posting as the block the prompt fences. */
export function postingText(p: NormalizedPosting): string {
  let description = p.descriptionMd ?? '(no description: a partial lead)';
  if (description.length > MAX_DESCRIPTION_CHARS) {
    description = `${description.slice(0, MAX_DESCRIPTION_CHARS)}\n[truncated]`;
  }
  const lines = [`Company: ${p.company}`, `Title: ${p.title}`];
  if (p.location != null) lines.push(`Location: ${p.location}`);
  if (p.remote != null) lines.push(`Remote: ${p.remote ? 'yes' : 'no'}`);
  if (p.compNote != null) lines.push(`Compensation: ${p.compNote}`);
  if (p.postedAt != null) lines.push(`Posted: ${new Date(p.postedAt).toISOString().slice(0, 10)}`);
  if (p.postingUrl != null) lines.push(`Link: ${p.postingUrl}`);
  return [...lines, '', 'Description:', description].join('\n');
}

/** The rationale as stored: the model's text plus its disqualifiers, bounded. */
function storedRationale(out: RankOutput, multiPosted: boolean): string {
  const parts = [out.rationale.trim()];
  if (out.disqualifiers.length > 0) {
    parts.push(`Disqualifiers: ${out.disqualifiers.map((d) => d.trim()).join('; ')}.`);
  }
  const text = parts.filter((p) => p.length > 0).join(' ');
  return (multiPosted ? `${MULTI_POSTED_PREFIX} ${text}` : text).slice(0, MAX_RATIONALE_CHARS);
}

export type RankRun =
  | { status: 'ranked'; score: number }
  | { status: 'skipped'; reason: 'missing' | 'not_pending' | 'no_prompt' | string };

/** Ranks one of the user's pending results and stores score and rationale. */
export async function rankResult(db: Db, ctx: UserCtx, resultId: string): Promise<RankRun> {
  let result: DiscoveryResultView;
  try {
    result = await getResult(db, ctx, resultId);
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 404) {
      return { status: 'skipped', reason: 'missing' };
    }
    throw err;
  }
  if (result.disposition !== 'pending') return { status: 'skipped', reason: 'not_pending' };

  const target =
    result.roleTargetId === null
      ? undefined
      : await db
          .select()
          .from(roleTargets)
          .where(and(eq(roleTargets.userId, ctx.userId), eq(roleTargets.id, result.roleTargetId)))
          .get();
  const resolved = await resolveDiscoveryPrompt(db, ctx, target ?? null);
  if (resolved === undefined) return { status: 'skipped', reason: 'no_prompt' };
  const roleTarget =
    target === undefined
      ? `No single role target is set for this source. Judge fit against all of the user's role targets:\n${await roleTargetsText(db, ctx)}`
      : roleTargetLine(target);

  let out: RankOutput;
  try {
    out = await runStructured(await buildAiDeps(db, ctx), 'discovery.rank', {
      system: renderPrompt(resolved.prompt.body, {
        role_target: roleTarget,
        posting_untrusted: postingText(result.posting),
      }),
      prompt: 'Score the posting and return the result.',
      schema: RankOutputSchema,
      promptId: resolved.prompt.id,
    });
  } catch (err) {
    // No key, over budget, or the provider is down: leave it unranked for manual triage.
    if (err instanceof AiUnavailableError) return { status: 'skipped', reason: err.reason };
    throw err;
  }
  const multiPosted = result.aiRationale?.startsWith(MULTI_POSTED_PREFIX) === true;
  const score = multiPosted ? Math.min(out.score, MULTI_POSTED_SCORE_CAP) : out.score;
  await setRanking(db, ctx, resultId, {
    aiScore: score,
    aiRationale: storedRationale(out, multiPosted),
  });
  return { status: 'ranked', score };
}

const PayloadSchema = z.object({ resultId: z.string().min(1).max(64) });

export const discoveryRankJob: JobHandler<z.infer<typeof PayloadSchema>> = {
  kind: DISCOVERY_RANK_KIND,
  payloadSchema: PayloadSchema,
  maxAttempts: 3,
  async run(db, payload, ctx) {
    if (ctx.userId === null) throw new Error(`${DISCOVERY_RANK_KIND} needs a user`);
    await ctx.setResult(
      await rankResult(db, { userId: ctx.userId, isAdmin: false }, payload.resultId),
    );
  },
};
