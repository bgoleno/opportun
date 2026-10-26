// Shared inbound-mail apply (FR-M1, FR-M5): one message from any mail source (Gmail sync, the
// Apple Mail connector) is stored the same way. The body goes to storage, the message is
// upserted on (user, channel, external id), and a message seen for the first time is routed:
// alert digests to discovery, everything else to the classifier. A re-delivered message that
// was stored but never routed (the enqueue failed after the commit) is routed then.
import type { CommChannel } from '@opportun/core';
import type { InboundMessage } from '../adapters/mailProvider';
import { isAlertDigest, processAlertDigest, senderAddress } from '../adapters/sources/alertEmail';
import { triageMessage } from '../lib/mailTriage';
import { gateApplies, gateMessage } from '../lib/triageGate';
import {
  accountAddress,
  listRules,
  readConsumerVeto,
  type MailFilterRuleRow,
} from '../repos/mailFilters';
import { and, eq, isNotNull } from 'drizzle-orm';
import { withTransaction, type Db } from '../db/client';
import { communications, jobs } from '../db/schema';
import { racePoint } from '../lib/racePoints';
import type { Storage } from '../lib/storage';
import type { UserCtx } from '../repos/base';
import { upsertInbound } from '../repos/communications';
import { enqueue } from './runner';
import type { Exec } from '../db/client';

export const CLASSIFY_JOB_KIND = 'comms.classify';
/** The sync_state row the Apple Mail connector's batches update (lastSyncAt, status). */
export const APPLE_MAIL_INTEGRATION = 'apple_mail';

export const classifyDedupeKey = (communicationId: string): string =>
  `comms.classify:${communicationId}`;

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

/**
 * Queues classification of one stored message (at most one unfinished job per message).
 *
 * `body` travels in the payload because it is not stored anywhere else (Plan 3 Task 1): the
 * classifier is the one consumer that needs the whole message, and the runner clears the field
 * when the job finishes. A caller without a body (a replay, the backfill) omits it, and the
 * classifier falls back to the snippet.
 */
export async function enqueueClassify(
  db: Db,
  ctx: UserCtx,
  communicationId: string,
  body?: string,
) {
  return enqueue(
    db,
    CLASSIFY_JOB_KIND,
    body === undefined || body.length === 0 ? { communicationId } : { communicationId, body },
    { dedupeKey: classifyDedupeKey(communicationId), userId: ctx.userId },
  );
}

/**
 * Where a newly stored message goes: an alert digest becomes discovery leads right here (no AI);
 * anything else is queued for the classifier. If digest processing fails, the message is queued
 * for comms.classify instead, whose handler routes digests the same way and can retry.
 *
 * `isDigest` is passed in rather than looked up again: Stage 1 needs the same answer for rule 4,
 * and asking twice is two reads of one user setting per message.
 */
async function routeNewMessage(
  db: Db,
  ctx: UserCtx,
  storage: Storage,
  communicationId: string,
  isDigest: boolean,
  body: string,
): Promise<void> {
  if (isDigest) {
    try {
      await processAlertDigest(db, ctx, storage, communicationId, body);
      return;
    } catch {
      // Fall through: the classify job retries the digest path, carrying the same body.
    }
  }
  await enqueueClassify(db, ctx, communicationId, body);
}

/**
 * True for a stored message that is unclassified and has never had a classify job. A message
 * whose job ran and left it unclassified (no AI key) is not re-queued here on every replay:
 * the classify backfill picks those up when a key is added.
 */
async function neverRouted(db: Db, ctx: UserCtx, communicationId: string): Promise<boolean> {
  const row = await db
    .select({ classification: communications.classification })
    .from(communications)
    .where(and(eq(communications.userId, ctx.userId), eq(communications.id, communicationId)))
    .get();
  if (row === undefined || row.classification !== null) return false;
  const job = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(eq(jobs.kind, CLASSIFY_JOB_KIND), eq(jobs.dedupeKey, classifyDedupeKey(communicationId))),
    )
    .get();
  return job === undefined;
}

/**
 * Rule 6: is this message's thread already linked to an opportunity.
 *
 * One indexed lookup per message, and unlike the rules and the toggles it cannot be cached per
 * user, because the answer is per thread. The index it uses is `communications_user_thread_idx`.
 */
async function threadLinked(db: Db, ctx: UserCtx, threadKey: string): Promise<boolean> {
  if (threadKey.trim().length === 0) return false;
  const row = await db
    .select({ id: communications.id })
    .from(communications)
    .where(
      and(
        eq(communications.userId, ctx.userId),
        eq(communications.threadKey, threadKey),
        isNotNull(communications.opportunityId),
      ),
    )
    .get();
  return row !== undefined;
}

/**
 * Stores one inbound message for the caller. `alongside` runs inside the upsert's transaction
 * (Gmail saves its cursor there, so a crash never skips or repeats a message). Routing (digest
 * or classifier) happens only when the row is new: a re-delivered message is an update.
 */
export async function ingestInbound(
  db: Db,
  ctx: UserCtx,
  storage: Storage,
  channel: CommChannel,
  message: InboundMessage,
  alongside?: (tx: Exec) => Promise<void>,
): Promise<{ id: string; inserted: boolean }> {
  // Stage 1 (spec D1 rules 0-7), before anything is written. A drop here means the body is
  // never stored and the message is never queued for the classifier, so its content reaches
  // no model at all. The decision is deterministic and local: no AI is involved in deciding
  // whether AI gets to see the message.
  const address = senderAddress(message.from);
  const [rules, consumerVeto, selfAddress] = await triageContext(db, ctx);
  // Rule 4's second half, and Stage 2's bypass list. Read live rather than through the cache
  // above, because a stale answer here either hides a digest from Discovery or spends a model
  // call on one, and the list is a single small setting.
  const digestSender = await isAlertDigest(db, ctx, message.from);
  const verdict = triageMessage({
    address,
    subject: message.subject,
    body: message.bodyText,
    rules,
    consumerVeto,
    selfAddress,
    threadLinked: await threadLinked(db, ctx, message.threadKey),
    digestSender,
  });
  // Stage 2 (decision D-1): the gate is consulted here, inside ingest and before anything is
  // written, and only about a message Stage 1 passed on a positive signal. A drop writes the
  // same contentless row rules 1 to 7 write, so nothing has to be cleaned up afterwards and
  // there is no window in which the body exists on disk. It is given the parsed address rather
  // than the raw From header: the display name is attacker-controlled and says nothing a model
  // needs. Every failure inside the gate is a pass (see lib/triageGate).
  const gate = gateApplies(verdict, digestSender)
    ? await gateMessage(db, ctx, {
        from: address,
        subject: message.subject,
        body: message.bodyText,
      })
    : null;
  const filtered = verdict.decision === 'drop' || gate?.decision === 'drop';
  const matchedRule = gate?.decision === 'drop' ? 'ai_gate' : verdict.matchedRule;
  // Plan 3 Task 1: the body is NOT written anywhere. What the row keeps is the snippet, the
  // extracted ATS references and the identifiers a deep link needs; the message itself stays in
  // the user's own mail system, which is the only copy that has to exist. The body travels from
  // here to the classifier in the job payload and is cleared when that job finishes.
  const body = message.bodyText;
  await racePoint('mail.ingest');
  const result = await withTransaction(db, async (tx) => {
    const res = await upsertInbound(tx, ctx, channel, message, {
      decision: filtered ? 'filtered' : 'passed',
      rule: matchedRule,
    });
    await alongside?.(tx);
    return res;
  });
  if (filtered) return result;
  if (result.inserted) {
    await routeNewMessage(db, ctx, storage, result.id, digestSender, body);
  } else if (await neverRouted(db, ctx, result.id)) {
    // Stored by an earlier delivery whose enqueue failed after the commit (a crash, a full
    // disk): the replay is the chance to heal it. The classify job routes digests too.
    await enqueueClassify(db, ctx, result.id);
  }
  return result;
}
