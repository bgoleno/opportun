// One-shot repair of alert-email leads whose fields the pre-fix LinkedIn parser shifted
// (15 rows observed live, 2026-10-19). The digest's own header line sits directly above the
// first job with no blank line, so the block walk absorbed it and every field moved down one:
// the header became the title, the title the company, the company the location, and the real
// location was dropped.
//
// The repair re-parses the source digest rather than shuffling columns. The shifted rows'
// dedupe keys were computed from shifted values, so moving fields in place would leave keys
// that do not match what the fixed parser produces for the same job, and the next digest would
// re-insert all of them as fresh leads. Re-parsing also recovers the dropped location.
// `externalId` came from the `View job:` link rather than the block, so it survived the shift
// and is the join key back to the digest.
import { buffer } from 'node:stream/consumers';
import { dedupeKey, NormalizedPostingSchema, type NormalizedPosting } from '@opportun/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { alertSenders, parseAlertDigest, senderAddress } from '../adapters/sources/alertEmail';
import type { Db } from '../db/client';
import { communications, discoveryResults, settings, users } from '../db/schema';
import { ALERT_HEADER } from '../lib/alertParsers/linkedin';
import { sanitizePosting } from '../lib/postingSanitize';
import type { Storage } from '../lib/storage';
import type { UserCtx } from '../repos/base';
import { requireService, type JobHandler } from './registry';
import { enqueue } from './runner';

export const REPAIR_ALERT_LEADS_KIND = 'discovery.repair_alert_leads';
/** Global marker (user_id NULL): the repair has been queued for this deployment. */
export const REPAIR_MARKER_KEY = 'repair_alert_leads:done';

export interface RepairOutcome {
  /** Shifted rows found. */
  scanned: number;
  /** Shifted rows whose digest was still on disk and could be re-parsed. */
  repaired: number;
}

/** True for a stored posting whose title is really the digest's header line. */
function isShifted(posting: Record<string, unknown>): boolean {
  const title = posting['title'];
  return typeof title === 'string' && ALERT_HEADER.test(title);
}

/**
 * Every job the user's stored alert digests still parse to, keyed by externalId. A digest whose
 * body has been purged is skipped: its leads cannot be recovered from here.
 */
async function leadsFromDigests(
  db: Db,
  ctx: UserCtx,
  storage: Storage,
): Promise<Map<string, NormalizedPosting>> {
  const senders = new Set(await alertSenders(db, ctx));
  const rows = await db
    .select({ from: communications.from, bodyRef: communications.bodyRef })
    .from(communications)
    .where(eq(communications.userId, ctx.userId))
    .all();
  const byExternalId = new Map<string, NormalizedPosting>();
  for (const row of rows) {
    if (row.bodyRef === null || !senders.has(senderAddress(row.from))) continue;
    let body: string;
    try {
      body = (await buffer(await storage.openAttachment(row.bodyRef))).toString('utf8');
    } catch {
      // The body is gone or unreadable; other digests may still repair their own leads.
      continue;
    }
    for (const raw of parseAlertDigest(body)) {
      // Same sanitize-and-validate every other discovery writer goes through
      // (discoveryRun.ts): it decodes HTML entities, collapses the nbsp runs html-to-text
      // leaves behind, and enforces the field caps. Writing parser output straight to the
      // table would put values in these rows that no other row can hold, and compute a
      // dedupe key from unsanitized text that the next digest's key will not match.
      const parsed = NormalizedPostingSchema.safeParse(sanitizePosting(raw));
      if (!parsed.success) continue;
      const lead = parsed.data;
      const externalId = lead.externalId;
      if (typeof externalId === 'string') byExternalId.set(externalId, lead);
    }
  }
  return byExternalId;
}

/** Repairs every shifted alert lead of one user that its digest can still account for. */
export async function repairAlertLeads(
  db: Db,
  ctx: UserCtx,
  storage: Storage,
): Promise<RepairOutcome> {
  const rows = await db
    .select({ id: discoveryResults.id, posting: discoveryResults.posting })
    .from(discoveryResults)
    .where(eq(discoveryResults.userId, ctx.userId))
    .all();
  const shifted = rows.filter((r) => isShifted(r.posting));
  if (shifted.length === 0) return { scanned: 0, repaired: 0 };

  const byExternalId = await leadsFromDigests(db, ctx, storage);
  let repaired = 0;
  for (const row of shifted) {
    const externalId = row.posting['externalId'];
    const fixed = typeof externalId === 'string' ? byExternalId.get(externalId) : undefined;
    if (fixed === undefined) continue;
    await db
      .update(discoveryResults)
      .set({
        posting: fixed,
        dedupeKey: dedupeKey(fixed.company, fixed.title, fixed.location),
        updatedAt: Date.now(),
      })
      .where(and(eq(discoveryResults.userId, ctx.userId), eq(discoveryResults.id, row.id)))
      .run();
    repaired += 1;
  }
  return { scanned: shifted.length, repaired };
}

/**
 * Queues the repair for every user, once per deployment. The marker is written whether or not
 * any user had shifted rows: the job is idempotent, but re-queueing it on every boot would walk
 * every stored digest body each time for nothing.
 *
 * The marker is NOT written when there are no users yet. A fresh install boots before anyone
 * registers, and marking it done there would retire the repair having done nothing, so a
 * database restored into that install would keep its shifted rows forever. With no users this
 * costs one count query per boot until the first registration.
 */
export async function enqueueRepairAlertLeadsOnce(db: Db): Promise<number> {
  const marker = await db
    .select({ key: settings.key })
    .from(settings)
    .where(eq(settings.key, REPAIR_MARKER_KEY))
    .get();
  if (marker !== undefined) return 0;
  const all = await db.select({ id: users.id }).from(users).all();
  if (all.length === 0) return 0;
  for (const { id } of all) {
    await enqueue(
      db,
      REPAIR_ALERT_LEADS_KIND,
      {},
      { dedupeKey: `${REPAIR_ALERT_LEADS_KIND}:${id}`, userId: id },
    );
  }
  await db
    .insert(settings)
    .values({ key: REPAIR_MARKER_KEY, userId: null, value: Date.now(), updatedAt: Date.now() })
    .onConflictDoNothing()
    .run();
  return all.length;
}

const PayloadSchema = z.object({}).strict();

export const repairAlertLeadsJob: JobHandler<z.infer<typeof PayloadSchema>> = {
  kind: REPAIR_ALERT_LEADS_KIND,
  payloadSchema: PayloadSchema,
  maxAttempts: 2,
  async run(db, _payload, ctx) {
    if (ctx.userId === null) throw new Error(`${REPAIR_ALERT_LEADS_KIND} needs a user`);
    const outcome = await repairAlertLeads(
      db,
      { userId: ctx.userId, isAdmin: false },
      requireService(ctx, 'storage'),
    );
    await ctx.setResult(outcome);
  },
};
