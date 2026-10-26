// Weekly classification prompt refinement (FR-D6 pattern applied to FR-M8). For each user with at
// least 5 classification corrections since their last refinement, the discovery.refine_prompt
// task proposes a revised comms.classify prompt. The proposal is stored as an inactive version
// flagged proposed; only the user's accept in AI settings activates it. Nothing here activates.
import {
  AiUnavailableError,
  promptVariables,
  RefineOutputSchema,
  renderPrompt,
  runStructured,
  TASK_PROMPT_VARS,
} from '@opportun/ai';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { dismissalFeedback, settings, users } from '../db/schema';
import { buildAiDeps } from '../lib/ai';
import type { UserCtx } from '../repos/base';
import { createProposedVersion, getActivePrompt } from '../repos/prompts';
import type { JobHandler } from './registry';

export const REFINE_JOB_KIND = 'comms.refine_prompt';
export const REFINE_CRON = '0 6 * * 1';
export const REFINE_MIN_FEEDBACK = 5;
const TARGET_TASK = 'comms.classify';
const MAX_SUMMARY_LINES = 40;

/** Per-user marker: the newest feedback row already used for a proposal. */
export const refineMarkerKey = (userId: string): string => `refine_classify:last_run:${userId}`;

async function readMarker(db: Db, ctx: UserCtx): Promise<number> {
  const value = (
    await db
      .select({ value: settings.value })
      .from(settings)
      .where(and(eq(settings.key, refineMarkerKey(ctx.userId)), eq(settings.userId, ctx.userId)))
      .get()
  )?.value;
  return typeof value === 'number' ? value : 0;
}

async function writeMarker(db: Db, ctx: UserCtx, at: number): Promise<void> {
  const now = Date.now();
  await db
    .insert(settings)
    .values({ key: refineMarkerKey(ctx.userId), userId: ctx.userId, value: at, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: at, updatedAt: now } })
    .run();
}

/**
 * The corrections as counted patterns ("3 times: outreach targeted -> broadcast_spam"). Only the
 * app's own descriptions of each change are used, never message text, so no personal content
 * reaches the prompt.
 */
export interface FeedbackRow {
  reason: string | null;
  kind: string;
  note: string | null;
  shareNote: boolean;
}

/**
 * One line per correction, counted. A rejection contributes its reason CODE, and its free
 * text only when the user ticked "include this note" for that note (spec D4): a note reading
 * "this is my chiropractor" is exactly the content this design keeps local, and the weekly
 * job sends whatever is in here to an external model.
 */
export function rejectionLines(rows: FeedbackRow[]): string[] {
  return rows
    .filter((r) => r.kind === 'rejection')
    .map((r) => {
      const code = (r.reason ?? 'other').trim() || 'other';
      const note = r.shareNote && r.note !== null ? r.note.trim().slice(0, 200) : '';
      return note === '' ? `rejected as ${code}` : `rejected as ${code}: ${note}`;
    });
}

export function feedbackSummary(reasons: (string | null)[]): string {
  const counts = new Map<string, number>();
  for (const r of reasons) {
    const key = (r ?? 'confirmed').trim() || 'confirmed';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const lines = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_SUMMARY_LINES)
    .map(([reason, n]) => `- ${n} ${n === 1 ? 'time' : 'times'}: ${reason}`);
  return [
    `The user corrected ${reasons.length} classifications since the last refinement.`,
    'Each line is a pattern of corrections: what the classifier said, then what the user chose.',
    ...lines,
  ].join('\n');
}

/** A proposal must keep exactly the classify task's placeholders. */
function placeholdersOk(body: string): boolean {
  const allowed = [...TASK_PROMPT_VARS['comms.classify']].sort();
  const used = promptVariables(body).sort();
  return used.length === allowed.length && used.every((v, i) => v === allowed.at(i));
}

export type RefineOutcome =
  | { status: 'proposed'; promptId: string; feedback: number }
  | {
      status: 'skipped';
      reason: 'not_enough_feedback' | 'no_prompt' | 'invalid_proposal' | string;
      feedback: number;
    };

/** One user's refinement pass. */
export async function refineForUser(db: Db, ctx: UserCtx): Promise<RefineOutcome> {
  const since = await readMarker(db, ctx);
  const rows = await db
    .select({
      reason: dismissalFeedback.reason,
      at: dismissalFeedback.at,
      kind: dismissalFeedback.kind,
      note: dismissalFeedback.note,
      shareNote: dismissalFeedback.shareNote,
    })
    .from(dismissalFeedback)
    .where(
      and(
        eq(dismissalFeedback.userId, ctx.userId),
        // Rejections are evidence about the filter too (spec D4), and a stronger signal
        // than a reclassification: the user said this should never have been here at all.
        inArray(dismissalFeedback.kind, ['classification', 'rejection']),
        gt(dismissalFeedback.at, since),
      ),
    )
    .orderBy(asc(dismissalFeedback.at))
    .all();
  if (rows.length < REFINE_MIN_FEEDBACK) {
    return { status: 'skipped', reason: 'not_enough_feedback', feedback: rows.length };
  }
  const current = await getActivePrompt(db, ctx, TARGET_TASK);
  const refine = await getActivePrompt(db, ctx, 'discovery.refine_prompt');
  if (current === undefined || refine === undefined) {
    return { status: 'skipped', reason: 'no_prompt', feedback: rows.length };
  }
  let out;
  try {
    out = await runStructured(await buildAiDeps(db, ctx), 'discovery.refine_prompt', {
      system: renderPrompt(refine.body, {
        current_prompt: current.body,
        feedback_summary: feedbackSummary([
          ...rows.filter((r) => r.kind === 'classification').map((r) => r.reason),
          ...rejectionLines(rows),
        ]),
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
  const proposal = await createProposedVersion(
    db,
    ctx,
    TARGET_TASK,
    body,
    out.changeSummary.trim().slice(0, 2000),
  );
  await writeMarker(db, ctx, rows.at(-1)?.at ?? Date.now());
  return { status: 'proposed', promptId: proposal.id, feedback: rows.length };
}

export const refineClassifyPromptJob: JobHandler<Record<string, never>> = {
  kind: REFINE_JOB_KIND,
  payloadSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  maxAttempts: 2,
  async run(db, _payload, ctx) {
    const results = new Map<string, RefineOutcome>();
    const all = await db.select({ id: users.id }).from(users).all();
    for (const { id } of all) {
      results.set(id, await refineForUser(db, { userId: id, isAdmin: false }));
    }
    await ctx.setResult(Object.fromEntries(results));
  },
};
