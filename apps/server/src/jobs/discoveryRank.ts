// discovery.rank job (FR-D4, FR-P3). Scores one pending result against the role target its
// source runs for, with that role target's discovery prompt (its linked version, else the
// user's active one, which is the system seed unless they changed it). The posting is passed as
// posting_untrusted, so renderPrompt fences it. Without AI the result stays pending, unranked:
// the user triages it by hand (manual path).
import {
  AiUnavailableError,
  RankOutputSchema as AiRankOutputSchema,
  systemWithCacheBreak,
  runStructured,
} from '@opportun/ai';
import type { NormalizedPosting } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withTransaction, type Db } from '../db/client';
import { roleTargets } from '../db/schema';
import { buildAiDeps } from '../lib/ai';
import { HttpError } from '../lib/errors';
import { racePoint } from '../lib/racePoints';
import type { UserCtx } from '../repos/base';
import {
  clearWaitingKeyReasons,
  getResult,
  hasOlderWaitingResult,
  setRankDeferred,
  setRankKeyRejected,
  setWaitingKeyRejected,
  setRankingIfPostingIs,
  setRankWaitingIfUnranked,
  readPostingBasis,
  setRankSkip,
  type DiscoveryResultView,
} from '../repos/discovery';
import { keyChangeScope, readKeyChangedAt } from '../repos/discoveryBudget';
import { resolveDiscoveryPrompt } from '../repos/profile';
import { roleTargetLine, roleTargetsText } from './classify';
import {
  DISCOVERY_RANK_KIND,
  MULTI_POSTED_PREFIX,
  MULTI_POSTED_SCORE_CAP,
  RANK_WAITING_KIND,
} from './discoveryKinds';
import { rankBudgetHasRoom } from './rankBudget';
import type { JobHandler } from './registry';
import { enqueue } from './runner';

export { DISCOVERY_RANK_KIND };

/** One unfinished drain per user: a second enqueue while one is queued or running does nothing. */
export async function enqueueRankWaiting(db: Db, ctx: UserCtx): Promise<void> {
  await enqueue(
    db,
    RANK_WAITING_KIND,
    {},
    { dedupeKey: `${RANK_WAITING_KIND}:${ctx.userId}`, userId: ctx.userId },
  );
}

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

/** rankResult's reason when a posting's text changed during the call, so nothing was stored. */
export const POSTING_CHANGED = 'posting_changed';

/** Ranks one of the user's pending results and stores score and rationale. */
export async function rankResult(db: Db, ctx: UserCtx, resultId: string): Promise<RankRun> {
  // Read before the posting: if the text changes between the two, the ranking is refused, and it can
  // never be stored against text it was not given.
  const basis = await readPostingBasis(db, ctx, resultId);
  if (basis === undefined) return { status: 'skipped', reason: 'missing' };
  await racePoint('discoveryRank.basis_read');
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

  // The discovery budget (#214): over it, the posting waits for a later budget day and the
  // provider is not called. Spend is on the ledger only when a call ends, so calls that passed
  // this check together can pass the budget by the calls in flight, and no further.
  if (!(await rankBudgetHasRoom(db, ctx))) {
    await setRankDeferred(db, ctx, resultId);
    return { status: 'skipped', reason: 'budget_exceeded' };
  }
  await racePoint('discoveryRank.budget_checked');

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
  // Before the key is read for this call.
  const callBegan = Date.now();
  try {
    out = await runStructured(await buildAiDeps(db, ctx), 'discovery.rank', {
      // Split before the posting (https://github.com/bgoleno/opportun/issues/356). The router
      // marks the part before it for the cache only when it is long enough to cache. The default
      // puts its output instructions before the posting (0061) so that, with the structured-output
      // prompt, it is (https://github.com/bgoleno/opportun/issues/388).
      ...systemWithCacheBreak(resolved.prompt.body, {
        role_target: roleTarget,
        posting_untrusted: postingText(result.posting),
      }),
      prompt: 'Score the posting and return the result.',
      schema: RankOutputSchema,
      promptId: resolved.prompt.id,
    });
  } catch (err) {
    // The per-task hard stop behind the budget: this waits too, since nothing is ever skipped
    // for budget (the owner's decision 2 on #190).
    if (err instanceof AiUnavailableError && err.reason === 'budget_exceeded') {
      await setRankDeferred(db, ctx, resultId);
      return { status: 'skipped', reason: err.reason };
    }
    // The provider refused the key. It joins the wait, so it is ranked once a key works, and every
    // waiting card says why. But a call that began before the latest key change says nothing about
    // the new key (qa and tl on #275): it marks nothing, and it is tried again with that key.
    if (err instanceof AiUnavailableError && err.keyRejected) {
      const stale = await withTransaction(
        db,
        async (tx) => {
          if ((await readKeyChangedAt(tx, ctx)) > callBegan) return true;
          await setRankKeyRejected(tx, ctx, resultId);
          await setWaitingKeyRejected(tx, ctx);
          return false;
        },
        { scope: keyChangeScope(ctx) },
      );
      if (!stale) return { status: 'skipped', reason: 'key_rejected' };
      await setRankDeferred(db, ctx, resultId);
      return { status: 'skipped', reason: 'key_changed' };
    }
    // No key, or the provider is down: leave it unranked for manual triage, and keep why on the
    // result so its card can say so (#210).
    if (err instanceof AiUnavailableError) {
      await setRankSkip(db, ctx, resultId, err.reason);
      return { status: 'skipped', reason: err.reason };
    }
    throw err;
  }
  const multiPosted = result.aiRationale?.startsWith(MULTI_POSTED_PREFIX) === true;
  const score = multiPosted ? Math.min(out.score, MULTI_POSTED_SCORE_CAP) : out.score;
  const stored = await setRankingIfPostingIs(
    db,
    ctx,
    resultId,
    { aiScore: score, aiRationale: storedRationale(out, multiPosted) },
    basis,
  );
  // However the key came back: adding one clears this too, but a policy change to a provider that
  // has one does not pass through there.
  await clearWaitingKeyReasons(db, ctx);
  if (!stored) {
    // The text changed during the call, so this score says nothing about it. If this is a rank job,
    // the one that change queued deduped onto it, and without a wait nothing would rank the new text.
    // The code cannot tell where a score already there came from; with one there, this changes nothing.
    await setRankWaitingIfUnranked(db, ctx, resultId);
    return { status: 'skipped', reason: POSTING_CHANGED };
  }
  return { status: 'ranked', score };
}

const PayloadSchema = z.object({ resultId: z.string().min(1).max(64) });

export const discoveryRankJob: JobHandler<z.infer<typeof PayloadSchema>> = {
  kind: DISCOVERY_RANK_KIND,
  payloadSchema: PayloadSchema,
  maxAttempts: 3,
  async run(db, payload, ctx) {
    if (ctx.userId === null) throw new Error(`${DISCOVERY_RANK_KIND} needs a user`);
    const user: UserCtx = { userId: ctx.userId, isAdmin: false };
    // While older postings wait for budget, a new one goes behind them (criterion 3 on #214, tl on
    // #230). Otherwise a source that runs just after the UTC day starts can spend the day's budget
    // before the sweep, every day, and the older ones wait for ever. This lives in the job and not
    // in rankResult because the drain calls rankResult directly: its own calls must go ahead. A
    // posting joining during a running drain is taken by that drain when it reads its list again.
    // One small window remains: a job that defers after the drain's last read, before its row is
    // finished, dedupes onto it, and the next hourly sweep takes that posting.
    if (await hasOlderWaitingResult(db, user, payload.resultId)) {
      await setRankDeferred(db, user, payload.resultId);
      if (await rankBudgetHasRoom(db, user)) await enqueueRankWaiting(db, user);
      await ctx.setResult({ status: 'skipped', reason: 'behind_older_waiting' });
      return;
    }
    const run = await rankResult(db, user, payload.resultId);
    // It joined the wait, and nothing else would rank it before the next sweep.
    if (run.status === 'skipped' && run.reason === 'key_changed') {
      if (await rankBudgetHasRoom(db, user)) await enqueueRankWaiting(db, user);
    }
    // The same, unless a score was already there.
    if (run.status === 'skipped' && run.reason === POSTING_CHANGED) {
      const { rankDeferredAt } = await getResult(db, user, payload.resultId);
      if (rankDeferredAt !== null && (await rankBudgetHasRoom(db, user))) {
        await enqueueRankWaiting(db, user);
      }
    }
    await ctx.setResult(run);
  },
};
