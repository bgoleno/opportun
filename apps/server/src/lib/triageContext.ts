// The Stage 1 mail triage inputs, cached per user, and what drops them
// (https://github.com/bgoleno/opportun/issues/763): in lib/ so the repos and routes that change a
// filter invalidate them without importing the mail-ingest job, which imports those repos back.
import type { Db } from '../db/client';
import type { UserCtx } from '../repos/base';
import {
  accountAddress,
  listRules,
  readConsumerVeto,
  type MailFilterRuleRow,
} from '../repos/mailFilters';

/**
 * The Stage 1 inputs, cached for a few seconds per user.
 *
 * A sync reads these once per message otherwise, which on the 1,768-message initial backfill
 * is thousands of queries for a value that changes when the user edits a settings page. The
 * window is short enough that an edit made mid-sync still takes effect within it, which is why
 * this is a TTL rather than a per-run snapshot.
 */
const TRIAGE_CACHE_MS = 5_000;
const triageCache = new Map<
  string,
  { at: number; value: [MailFilterRuleRow[], boolean, string | null] }
>();

export async function triageContext(
  db: Db,
  ctx: UserCtx,
): Promise<[MailFilterRuleRow[], boolean, string | null]> {
  const hit = triageCache.get(ctx.userId);
  const now = Date.now();
  if (hit !== undefined && now - hit.at < TRIAGE_CACHE_MS) return hit.value;
  const value: [MailFilterRuleRow[], boolean, string | null] = [
    await listRules(db, ctx),
    await readConsumerVeto(db, ctx),
    await accountAddress(db, ctx),
  ];
  triageCache.set(ctx.userId, { at: now, value });
  return value;
}

/** Drops the cached Stage 1 inputs for a user, so a settings edit takes effect at once. */
export function invalidateTriageContext(userId: string): void {
  triageCache.delete(userId);
}
