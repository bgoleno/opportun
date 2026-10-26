// Weekly discovery prompt refinement (FR-D6), the discovery variant of refineClassifyPrompt.ts.
// For each role target with at least 5 dismissals since its last refinement (a dismissal counts
// for a role target through the dismissed result's run, or the dismissed opportunity's role
// target), the discovery.refine_prompt task proposes a revised version of the prompt that role
// target ranks with. The proposal is an inactive, flagged version tied to the role target; only
// the user's accept links it. Nothing here activates or links anything.
import {
  AiUnavailableError,
  promptVariables,
  RefineOutputSchema,
  renderPrompt,
  runStructured,
  TASK_PROMPT_VARS,
} from '@opportun/ai';
import { and, asc, eq, gt, isNull, notInArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import {
  discoveryResults,
  discoveryRuns,
  dismissalFeedback,
  opportunities,
  roleTargets,
  settings,
  users,
} from '../db/schema';
import { buildAiDeps } from '../lib/ai';
import type { UserCtx } from '../repos/base';
import { resolveDiscoveryPrompt, type RoleTargetRow } from '../repos/profile';
import { createRoleTargetProposal, getActivePrompt } from '../repos/prompts';
import type { JobHandler } from './registry';
import type { RefineOutcome } from './refineClassifyPrompt';

export const DISCOVERY_REFINE_KIND = 'discovery.refine_prompt';
export const DISCOVERY_REFINE_CRON = '0 6 * * 3';
export const DISCOVERY_REFINE_MIN_FEEDBACK = 5;
const MAX_SUMMARY_LINES = 40;

/**
 * Dismissal reasons excluded below from both the refinement threshold and the prompt's feedback
 * summary (#184), for different reasons, not one:
 *
 * - `not_interested` is empty: a batch triage call that says nothing about which axis was wrong.
 *   There is nothing here to learn from.
 * - `duplicate` is not empty, and is not about role fit at all: it is a report that OUR dedupe
 *   missed a posting already tracked, i.e. a different subsystem's bug. Counting it toward
 *   refinement would make discovery respond to "you showed me this twice" by scoring that kind
 *   of role down, teaching the prompt something false about a role the user actually wants.
 * - `denied_company` (#199) is the same shape as `duplicate`, not as `not_interested`: it is not
 *   empty, it is a misleading signal about a different subsystem (the user's own denylist, not
 *   role fit). The company is already fully excluded by the denylist itself; counting every
 *   auto-suppressed posting as dismissal evidence would teach discovery to avoid that kind of
 *   role, when the only fact is "this specific company is on a list," which the denylist already
 *   and permanently handles.
 *
 * All three land here because each, counted, would corrupt the evidence the prompt is refined
 * from, not because they mean the same thing. Do not add a fourth reason to this list by asking
 * "does this carry no signal" rather than "would counting this teach the prompt something false
 * about the role." Do not remove any without re-reading #184's "The part that is easy to get
 * wrong".
 */
const REASONS_EXCLUDED_FROM_REFINEMENT = ['not_interested', 'duplicate', 'denied_company'] as const;

/** Per role target marker: the newest dismissal already used for a proposal. */
export const discoveryRefineMarkerKey = (roleTargetId: string): string =>
  `refine_discovery:last_run:${roleTargetId}`;

async function readMarker(db: Db, ctx: UserCtx, roleTargetId: string): Promise<number> {
  const value = (
    await db
      .select({ value: settings.value })
      .from(settings)
      .where(
        and(
          eq(settings.key, discoveryRefineMarkerKey(roleTargetId)),
          eq(settings.userId, ctx.userId),
        ),
      )
      .get()
  )?.value;
  return typeof value === 'number' ? value : 0;
}

async function writeMarker(db: Db, ctx: UserCtx, roleTargetId: string, at: number): Promise<void> {
  const now = Date.now();
  await db
    .insert(settings)
    .values({
      key: discoveryRefineMarkerKey(roleTargetId),
      userId: ctx.userId,
      value: at,
      updatedAt: now,
    })
    .onConflictDoUpdate({ target: settings.key, set: { value: at, updatedAt: now } })
    .run();
}

/**
 * Dismissal reasons as counted patterns. Reasons are the fixed DISMISS_REASONS values; notes and
 * posting text are never included, so no personal or third-party content reaches the prompt.
 */
export function dismissalSummary(reasons: (string | null)[]): string {
  const counts = new Map<string, number>();
  for (const r of reasons) {
    const key = (r ?? 'no reason given').trim() || 'no reason given';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const lines = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_SUMMARY_LINES)
    .map(([reason, n]) => `- ${n} ${n === 1 ? 'time' : 'times'}: ${reason}`);
  return [
    `The prompt being refined scores job postings for one role target. The user dismissed ${reasons.length} postings matched to it since the last refinement.`,
    'Each line is a dismissal reason and how often the user gave it.',
    ...lines,
  ].join('\n');
}

function placeholdersOk(body: string): boolean {
  const allowed = [...TASK_PROMPT_VARS['discovery.rank']].sort();
  const used = promptVariables(body).sort();
  return used.length === allowed.length && used.every((v, i) => v === allowed.at(i));
}

/** Dismissals attributed to the role target, newer than `since`, oldest first. */
async function dismissalsFor(db: Db, ctx: UserCtx, roleTargetId: string, since: number) {
  return await db
    .select({ reason: dismissalFeedback.reason, at: dismissalFeedback.at })
    .from(dismissalFeedback)
    .leftJoin(
      discoveryResults,
      and(
        eq(discoveryResults.id, dismissalFeedback.resultId),
        eq(discoveryResults.userId, ctx.userId),
      ),
    )
    .leftJoin(discoveryRuns, eq(discoveryRuns.id, discoveryResults.runId))
    .leftJoin(
      opportunities,
      and(
        eq(opportunities.id, dismissalFeedback.opportunityId),
        eq(opportunities.userId, ctx.userId),
      ),
    )
    .where(
      and(
        eq(dismissalFeedback.userId, ctx.userId),
        eq(dismissalFeedback.kind, 'dismissal'),
        gt(dismissalFeedback.at, since),
        sql`coalesce(${discoveryRuns.roleTargetId}, ${opportunities.roleTargetId}) = ${roleTargetId}`,
        // See REASONS_EXCLUDED_FROM_REFINEMENT above: the row is still written (the dismissal
        // happened, for that stated reason, and export/audit should see it); it is excluded
        // only from this evidence query.
        or(
          isNull(dismissalFeedback.reason),
          notInArray(dismissalFeedback.reason, [...REASONS_EXCLUDED_FROM_REFINEMENT]),
        ),
      ),
    )
    .orderBy(asc(dismissalFeedback.at))
    .all();
}

/** One role target's refinement pass. */
export async function refineForRoleTarget(
  db: Db,
  ctx: UserCtx,
  target: RoleTargetRow,
): Promise<RefineOutcome> {
  const rows = await dismissalsFor(db, ctx, target.id, await readMarker(db, ctx, target.id));
  if (rows.length < DISCOVERY_REFINE_MIN_FEEDBACK) {
    return { status: 'skipped', reason: 'not_enough_feedback', feedback: rows.length };
  }
  const current = await resolveDiscoveryPrompt(db, ctx, target);
  const refine = await getActivePrompt(db, ctx, 'discovery.refine_prompt');
  if (current === undefined || refine === undefined) {
    return { status: 'skipped', reason: 'no_prompt', feedback: rows.length };
  }
  let out;
  try {
    out = await runStructured(await buildAiDeps(db, ctx), 'discovery.refine_prompt', {
      system: renderPrompt(refine.body, {
        current_prompt: current.prompt.body,
        feedback_summary: dismissalSummary(rows.map((r) => r.reason)),
      }),
      prompt: 'Propose the revised prompt.',
      schema: RefineOutputSchema,
      promptId: refine.id,
    });
  } catch (err) {
    if (err instanceof AiUnavailableError) {
      return { status: 'skipped', reason: err.reason, feedback: rows.length };
    }
    throw err;
  }
  const body = out.proposedPrompt.trim();
  if (body.length === 0 || body.length > 50_000 || !placeholdersOk(body)) {
    return { status: 'skipped', reason: 'invalid_proposal', feedback: rows.length };
  }
  const proposal = await createRoleTargetProposal(
    db,
    ctx,
    target.id,
    current.prompt.id,
    body,
    out.changeSummary.trim().slice(0, 2000),
  );
  await writeMarker(db, ctx, target.id, rows.at(-1)?.at ?? Date.now());
  return { status: 'proposed', promptId: proposal.id, feedback: rows.length };
}

export const refineDiscoveryPromptJob: JobHandler<Record<string, never>> = {
  kind: DISCOVERY_REFINE_KIND,
  payloadSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  maxAttempts: 2,
  async run(db, _payload, ctx) {
    const results = new Map<string, Record<string, RefineOutcome>>();
    for (const { id: userId } of await db.select({ id: users.id }).from(users).all()) {
      const user: UserCtx = { userId, isAdmin: false };
      const targets = await db
        .select()
        .from(roleTargets)
        .where(eq(roleTargets.userId, userId))
        .all();
      const perTarget = new Map<string, RefineOutcome>();
      for (const target of targets) {
        perTarget.set(target.id, await refineForRoleTarget(db, user, target));
      }
      results.set(userId, Object.fromEntries(perTarget));
    }
    await ctx.setResult(Object.fromEntries(results));
  },
};
