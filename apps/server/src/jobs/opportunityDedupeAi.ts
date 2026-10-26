// opportunity.dedupe AI consumer (issue #94's second PR, stacked on the first). The heuristic
// pass (../repos/opportunityDedupe.ts) queues an ambiguous same-company, title-overlapping pair
// as a 'pending' row rather than guessing; this is what actually resolves it, one AI call per
// row, using the opportunity.dedupe task that design.md already specced and packages/ai/tasks.ts
// already scaffolded (policy, input/output schema, a seeded default prompt in
// apps/server/drizzle/0002_prompt_seeds.sql) but that nothing had ever called until now.
//
// A daily sweep, never inline: the heuristic runs synchronously at create/update because it is
// free; this calls a model, so it runs on its own schedule, the same shape as #101's
// retryWorkdayCapture. Capped at OPPORTUNITY_DEDUPE_AI_MAX_PER_RUN pending rows per run across
// every user: a placeholder (25), pending real usage, not a measurement -- the only instance
// running this holds single-digit opportunities, so there is no backlog yet to measure against.
// The router's own per-user, per-task daily budget (packages/ai/src/router.ts) is the hard stop
// against runaway spend regardless of this cap; the cap is about not letting one run grind
// through an unbounded backlog in one go, not about cost per se.
//
// The task's prompt and schema were designed for an asymmetric case (a brand-new, not-yet-
// created posting compared against the user's already-tracked opportunities), named
// accordingly: "existing_opportunities" get a ref, the "candidate" does not, and the model
// echoes a ref back to confirm. A pending row here is symmetric -- both sides are already full
// opportunities -- so one side is arbitrarily sent as "tracked" (opportunityIdA) and the other
// as "candidate" (opportunityIdB); which one plays which role has no bearing on the outcome,
// since "same role at the same company" does not depend on which side asked first.
import { AiUnavailableError, DedupeOutputSchema, renderPrompt, runStructured } from '@opportun/ai';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { companies, opportunities, opportunityDedupeCandidates } from '../db/schema';
import { buildAiDeps } from '../lib/ai';
import { resolveDedupeCandidateByAi } from '../repos/opportunityDedupe';
import { getActivePrompt } from '../repos/prompts';
import { requireService, type JobHandler } from './registry';

export const OPPORTUNITY_DEDUPE_AI_KIND = 'opportunity.dedupe_ai_pass';
export const OPPORTUNITY_DEDUPE_AI_CRON = '15 7 * * *';
export const OPPORTUNITY_DEDUPE_AI_TASK = 'opportunity.dedupe';
/** Pending rows one sweep attempts at most, across every user -- see the file header. */
export const OPPORTUNITY_DEDUPE_AI_MAX_PER_RUN = 25;

export interface OpportunityDedupeAiOutcome {
  /** Pending rows this sweep actually sent to the model (within the per-run cap, both sides
   *  still present, a prompt configured). */
  scanned: number;
  confirmed: number;
  rejected: number;
}

interface OppForPrompt {
  id: string;
  companyName: string;
  title: string;
  location: string | null;
  postingUrl: string | null;
  possibleDuplicateOf: string | null;
}

async function loadOpp(
  db: Db,
  userId: string,
  opportunityId: string,
): Promise<OppForPrompt | undefined> {
  return await db
    .select({
      id: opportunities.id,
      companyName: companies.name,
      title: opportunities.title,
      location: opportunities.location,
      postingUrl: opportunities.postingUrl,
      possibleDuplicateOf: opportunities.possibleDuplicateOf,
    })
    .from(opportunities)
    .innerJoin(companies, eq(companies.id, opportunities.companyId))
    .where(and(eq(opportunities.userId, userId), eq(opportunities.id, opportunityId)))
    .get();
}

/** `ref` is included only for the tracked side; the candidate is sent without one, since
 *  nothing needs to echo its identity back. */
function oppLine(o: OppForPrompt, ref?: string): string {
  const lines = ref === undefined ? [] : [`Ref: ${ref}`];
  lines.push(`Company: ${o.companyName}`, `Title: ${o.title}`);
  if (o.location !== null) lines.push(`Location: ${o.location}`);
  if (o.postingUrl !== null) lines.push(`Posting URL: ${o.postingUrl}`);
  return lines.join('\n');
}

export async function runOpportunityDedupeAi(
  db: Db,
  sctx: { log: { warn: (obj: unknown, msg: string) => void } },
): Promise<OpportunityDedupeAiOutcome> {
  const rows = await db
    .select({
      id: opportunityDedupeCandidates.id,
      userId: opportunityDedupeCandidates.userId,
      opportunityIdA: opportunityDedupeCandidates.opportunityIdA,
      opportunityIdB: opportunityDedupeCandidates.opportunityIdB,
    })
    .from(opportunityDedupeCandidates)
    .where(eq(opportunityDedupeCandidates.decision, 'pending'))
    .orderBy(asc(opportunityDedupeCandidates.createdAt))
    .limit(OPPORTUNITY_DEDUPE_AI_MAX_PER_RUN)
    .all();

  let scanned = 0;
  let confirmed = 0;
  let rejected = 0;
  for (const row of rows) {
    const ctx = { userId: row.userId, isAdmin: false };
    const [tracked, candidate] = await Promise.all([
      loadOpp(db, row.userId, row.opportunityIdA),
      loadOpp(db, row.userId, row.opportunityIdB),
    ]);
    // Deleting either opportunity cascades the candidate row away (the table's own FKs), so
    // this is only reachable from a race between that delete and this sweep reading the row
    // first; either way there is nothing left to ask about.
    if (tracked === undefined || candidate === undefined) continue;

    const prompt = await getActivePrompt(db, ctx, OPPORTUNITY_DEDUPE_AI_TASK);
    if (prompt === undefined) continue;

    scanned += 1;
    let out: z.infer<typeof DedupeOutputSchema>;
    try {
      out = await runStructured(await buildAiDeps(db, ctx), OPPORTUNITY_DEDUPE_AI_TASK, {
        system: renderPrompt(prompt.body, {
          existing_opportunities_untrusted: oppLine(tracked, tracked.id),
          candidate_untrusted: oppLine(candidate),
        }),
        prompt:
          'Decide whether the candidate duplicates the tracked opportunity and return the result.',
        schema: DedupeOutputSchema,
        promptId: prompt.id,
      });
    } catch (err) {
      if (err instanceof AiUnavailableError) {
        sctx.log.warn(
          { candidateId: row.id, reason: err.reason },
          'opportunity dedupe AI unavailable',
        );
        continue;
      }
      throw err;
    }

    const now = Date.now();
    const verdict = await resolveDedupeCandidateByAi(
      db,
      ctx,
      tracked.id,
      candidate.id,
      out.duplicateOfRef,
      candidate.possibleDuplicateOf !== null,
      now,
    );
    if (verdict === 'confirmed') confirmed += 1;
    else if (verdict === 'rejected') rejected += 1;
    else
      sctx.log.warn(
        { candidateId: row.id, ref: out.duplicateOfRef },
        'opportunity dedupe AI returned an unrecognized ref',
      );
  }
  return { scanned, confirmed, rejected };
}

const PayloadSchema = z.object({}).strict() as unknown as z.ZodType<Record<string, never>>;

export const opportunityDedupeAiJob: JobHandler<Record<string, never>> = {
  kind: OPPORTUNITY_DEDUPE_AI_KIND,
  payloadSchema: PayloadSchema,
  maxAttempts: 1,
  async run(db, _payload, ctx) {
    const outcome = await runOpportunityDedupeAi(db, { log: requireService(ctx, 'log') });
    await ctx.setResult(outcome);
  },
};
