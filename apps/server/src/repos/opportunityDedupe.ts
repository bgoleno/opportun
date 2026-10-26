// Near-miss duplicate detection (issue #94, FR-O7/FR-O10's first, heuristic-only PR). The exact
// dedupeKey match (opportunities.ts) catches only a company/title/location string that
// normalizes identically; a company name variant ("Acme Robotics" vs "Acme Robotics, Inc.") or
// a reworded title never collides there, so createOpportunity never even reaches the 409 that
// would have let a user force past it and record the pairing (#9).
//
// This runs the cheap heuristic design.md names (same company after companyMatchKey's
// suffix-aware normalization, title token overlap at or above leadResolve's own
// TITLE_MATCH_THRESHOLD) inline at create/update, no model call, so there is no budget or
// async concern for this PR. A confident match (>= DEDUPE_CONFIDENT_THRESHOLD) writes
// opportunities.possible_duplicate_of directly, the same surface #102 built, but only when
// that column is not already set: an existing value, whether from #9's force-create override
// or an earlier call here, is never clobbered by a second, independent match. Anything from
// TITLE_MATCH_THRESHOLD up to the confident threshold is recorded as a 'pending' row in
// opportunity_dedupe_candidates and left for a future AI pass (#94's second PR) to resolve; it
// is not surfaced to the user on heuristic score alone, because a guess should not look as
// certain as a known fact.
//
// What makes a decision sticky: before writing anything, a pair's existing decision (if any)
// is checked first. A 'rejected' row (written today only by dismissPossibleDuplicate in
// opportunities.ts; a future AI pass's own "no" would write the same way) is never revisited,
// and a 'confirmed' pair is never re-scored. Without this, re-running on a later edit to
// either opportunity's title or company would undo a user's own dismissal.
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { companyMatchKey, newId } from '@opportun/core';
import type { DedupeCandidateDecidedBy, DedupeCandidateDecision } from '../db/schema.shared';
import { TITLE_MATCH_THRESHOLD, titleOverlap } from '../jobs/leadResolve';
import { companies, opportunities, opportunityDedupeCandidates } from '../db/schema';
import type { Exec, UserCtx } from './base';

/**
 * Above this, a same-company title match is confident enough to write possibleDuplicateOf
 * directly rather than queue a guess. Deliberately higher than TITLE_MATCH_THRESHOLD (0.6):
 * there, a wrong guess silently leaves a lead 'needs_capture' for the user to capture by hand;
 * here, a wrong guess is a user-visible badge and a one-click merge offer. A placeholder
 * pending real usage, same as CAPTURE_RETRY_MAX_PER_HOST_PER_RUN in retryWorkdayCapture.ts:
 * named and commented so the next person knows it is a guess, not a measurement.
 */
export const DEDUPE_CONFIDENT_THRESHOLD = 0.85;

/** The pair, ordered so each unordered pair has exactly one row regardless of which side
 *  triggered detection. */
function pairIds(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

async function existingDecision(
  exec: Exec,
  idA: string,
  idB: string,
): Promise<DedupeCandidateDecision | undefined> {
  const [a, b] = pairIds(idA, idB);
  const row = await exec
    .select({ decision: opportunityDedupeCandidates.decision })
    .from(opportunityDedupeCandidates)
    .where(
      and(
        eq(opportunityDedupeCandidates.opportunityIdA, a),
        eq(opportunityDedupeCandidates.opportunityIdB, b),
      ),
    )
    .get();
  return row?.decision;
}

/** Upserts the single row for this pair: a repeat detection updates the existing row (its
 *  score may have moved since an edit) instead of accumulating duplicates under the unique
 *  index on (opportunity_id_a, opportunity_id_b). */
async function recordDecision(
  exec: Exec,
  ctx: UserCtx,
  idA: string,
  idB: string,
  decision: DedupeCandidateDecision,
  decidedBy: DedupeCandidateDecidedBy | null,
  score: number | null,
  now: number,
): Promise<void> {
  const [a, b] = pairIds(idA, idB);
  const existing = await exec
    .select({ id: opportunityDedupeCandidates.id })
    .from(opportunityDedupeCandidates)
    .where(
      and(
        eq(opportunityDedupeCandidates.opportunityIdA, a),
        eq(opportunityDedupeCandidates.opportunityIdB, b),
      ),
    )
    .get();
  if (existing === undefined) {
    await exec
      .insert(opportunityDedupeCandidates)
      .values({
        id: newId(),
        userId: ctx.userId,
        opportunityIdA: a,
        opportunityIdB: b,
        score,
        decision,
        decidedBy,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } else {
    await exec
      .update(opportunityDedupeCandidates)
      .set({ decision, decidedBy, ...(score === null ? {} : { score }), updatedAt: now })
      .where(eq(opportunityDedupeCandidates.id, existing.id))
      .run();
  }
}

/**
 * Marks a pair 'rejected' (a user's dismiss-duplicate, or a future AI pass's own "no"), so it
 * is never re-proposed. Exported for dismissPossibleDuplicate (opportunities.ts); no score is
 * computed here, since the pair this clears may have been linked only via #9's exact-key force
 * override, which never ran this heuristic at all.
 */
export async function rejectDedupeCandidate(
  exec: Exec,
  ctx: UserCtx,
  idA: string,
  idB: string,
  decidedBy: DedupeCandidateDecidedBy,
  now: number,
): Promise<void> {
  await recordDecision(exec, ctx, idA, idB, 'rejected', decidedBy, null, now);
}

/**
 * Resolves a 'pending' pair from the AI pass's own verdict (issue #94's second PR), the same
 * "never overwrite" rule as the heuristic's confident match: a `duplicateOfRef` that echoes
 * `trackedId` confirms the pair and writes possible_duplicate_of on `candidateId`, but only
 * when `candidateHasPossibleDuplicateOf` is false. A null ref rejects it. Anything else -- a
 * ref the model was not sent -- is not a judgment either way (design principle 6: report only
 * outcomes observed), so nothing is recorded and the row stays pending.
 */
export async function resolveDedupeCandidateByAi(
  exec: Exec,
  ctx: UserCtx,
  trackedId: string,
  candidateId: string,
  duplicateOfRef: string | null,
  candidateHasPossibleDuplicateOf: boolean,
  now: number,
): Promise<'confirmed' | 'rejected' | 'invalid'> {
  if (duplicateOfRef === null) {
    await recordDecision(exec, ctx, trackedId, candidateId, 'rejected', 'ai', null, now);
    return 'rejected';
  }
  if (duplicateOfRef !== trackedId) return 'invalid';
  await recordDecision(exec, ctx, trackedId, candidateId, 'confirmed', 'ai', null, now);
  if (!candidateHasPossibleDuplicateOf) {
    await exec
      .update(opportunities)
      .set({ possibleDuplicateOf: trackedId, updatedAt: now })
      .where(and(eq(opportunities.userId, ctx.userId), eq(opportunities.id, candidateId)))
      .run();
  }
  return 'confirmed';
}

interface MatchCandidate {
  id: string;
  score: number;
}

async function findMatches(
  exec: Exec,
  ctx: UserCtx,
  opportunityId: string,
  companyName: string,
  title: string,
): Promise<MatchCandidate[]> {
  const key = companyMatchKey(companyName);
  // `OR company_match_key IS NULL` is the correctness backstop for a company the one-shot
  // backfill (companyMatchKeyRepair.ts) has not reached yet, or that failed partway through:
  // without it, a missing key would silently narrow the scan instead of widening it, which
  // would make a cache miss look like "no duplicate" rather than "not sure yet". A row that
  // survives the SQL filter this way still needs its own companyMatchKey recomputed and
  // compared below, the same check findMatches ran on every row before this column existed;
  // it is now paid only for the shrinking set of not-yet-backfilled companies, not the user's
  // whole active set.
  const others = await exec
    .select({
      id: opportunities.id,
      title: opportunities.title,
      companyName: companies.name,
      companyMatchKey: companies.companyMatchKey,
    })
    .from(opportunities)
    .innerJoin(companies, eq(companies.id, opportunities.companyId))
    .where(
      and(
        eq(opportunities.userId, ctx.userId),
        ne(opportunities.id, opportunityId),
        ne(opportunities.stage, 'dismissed'),
        or(eq(companies.companyMatchKey, key), isNull(companies.companyMatchKey)),
      ),
    )
    .all();
  const out: MatchCandidate[] = [];
  for (const o of others) {
    if (o.companyMatchKey === null && companyMatchKey(o.companyName) !== key) continue;
    const score = titleOverlap(title, o.title);
    if (score >= TITLE_MATCH_THRESHOLD) out.push({ id: o.id, score });
  }
  return out;
}

/**
 * Runs the heuristic for one opportunity against this user's other active opportunities and
 * records whatever it finds (see the file header for the full shape). Called inside the same
 * transaction as the create/update that may have changed `companyName` or `title`, so a
 * confident match's possibleDuplicateOf write is atomic with the row it describes.
 *
 * `hasPossibleDuplicateOf` is the opportunity's own possible_duplicate_of state going into this
 * call (not re-read here, since the caller already has it from the row it just wrote).
 */
export async function detectDedupeCandidates(
  exec: Exec,
  ctx: UserCtx,
  opportunityId: string,
  companyName: string,
  title: string,
  hasPossibleDuplicateOf: boolean,
  now: number,
): Promise<void> {
  const matches = await findMatches(exec, ctx, opportunityId, companyName, title);
  let linked = hasPossibleDuplicateOf;
  for (const match of matches) {
    const existing = await existingDecision(exec, opportunityId, match.id);
    if (existing === 'rejected' || existing === 'confirmed') continue;
    if (match.score >= DEDUPE_CONFIDENT_THRESHOLD) {
      await recordDecision(
        exec,
        ctx,
        opportunityId,
        match.id,
        'confirmed',
        'heuristic',
        match.score,
        now,
      );
      if (!linked) {
        await exec
          .update(opportunities)
          .set({ possibleDuplicateOf: match.id, updatedAt: now })
          .where(and(eq(opportunities.userId, ctx.userId), eq(opportunities.id, opportunityId)))
          .run();
        linked = true;
      }
    } else {
      await recordDecision(exec, ctx, opportunityId, match.id, 'pending', null, match.score, now);
    }
  }
}
