// Gmail sync job (FR-M1). Pulls new messages through the mail provider, stores each body in
// storage and the message in communications (upsert), and queues classification for messages
// seen for the first time. Job alert digests (Task 12) are routed before that: their leads go
// to the discovery queue deterministically and the AI classifier never sees them. The cursor
// is saved after every message, so a crash resumes close to where it stopped; a re-delivered
// message is an update, never a duplicate.
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { runSync, type MailProvider } from '../adapters/mailProvider';
import type { Db } from '../db/client';
import { syncState } from '../db/schema';
import { HttpError } from '../lib/errors';
import { GMAIL_SCOPES, googleErrorReason, googleErrorStatus, readTokens } from '../lib/google';
import type { Storage } from '../lib/storage';
import type { UserCtx } from '../repos/base';
import { getSyncState, putSyncState } from '../repos/communications';
import { ingestInbound } from './mailIngest';
import { requireService, type JobHandler } from './registry';
import { enqueue } from './runner';

export const GMAIL_SYNC_KIND = 'gmail.sync';
export const GMAIL_INTEGRATION = 'gmail';
export { CLASSIFY_JOB_KIND, classifyDedupeKey, enqueueClassify } from './mailIngest';

export const gmailSyncDedupeKey = (userId: string): string => `gmail:${userId}`;

export interface SyncOutcome {
  stored: number;
  inserted: number;
}

/** One sync run for the user: everything after the stored cursor. */
export async function syncMailbox(
  db: Db,
  ctx: UserCtx,
  provider: MailProvider,
  storage: Storage,
): Promise<SyncOutcome> {
  const state = await getSyncState(db, ctx, GMAIL_INTEGRATION);
  const outcome: SyncOutcome = { stored: 0, inserted: 0 };
  await putSyncState(db, ctx, GMAIL_INTEGRATION, { status: 'running' });
  try {
    const final = await runSync(provider, db, ctx, state?.cursor ?? null, async (item) => {
      const { inserted } = await ingestInbound(
        db,
        ctx,
        storage,
        'gmail',
        item.message,
        async (tx) => await putSyncState(tx, ctx, GMAIL_INTEGRATION, { cursor: item.nextCursor }),
      );
      outcome.stored += 1;
      if (inserted) outcome.inserted += 1;
    });
    await putSyncState(db, ctx, GMAIL_INTEGRATION, {
      cursor: final,
      lastSyncAt: Date.now(),
      status: 'ok',
    });
  } catch (err) {
    await putSyncState(db, ctx, GMAIL_INTEGRATION, { status: 'error' });
    // A Google client error carries its request; only a status code goes into jobs.last_error.
    if (err instanceof HttpError) throw err;
    const status = googleErrorStatus(err);
    // The reason is an enum-like string (e.g. rateLimitExceeded), safe to surface.
    const reason = googleErrorReason(err);
    const detail = [
      ...(status === undefined ? [] : [`status ${status}`]),
      ...(reason === undefined ? [] : [reason]),
    ].join(', ');
    // eslint-disable-next-line preserve-caught-error -- the cause would carry the request
    throw new Error(`gmail sync failed${detail.length === 0 ? '' : ` (${detail})`}`);
  }
  return outcome;
}

export const gmailSyncJob: JobHandler<Record<string, never>> = {
  kind: GMAIL_SYNC_KIND,
  payloadSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  maxAttempts: 3,
  async run(db, _payload, ctx) {
    if (ctx.userId === null) throw new Error('gmail.sync needs a user');
    const user: UserCtx = { userId: ctx.userId, isAdmin: false };
    try {
      const outcome = await syncMailbox(
        db,
        user,
        requireService(ctx, 'mailProvider'),
        requireService(ctx, 'storage'),
      );
      await ctx.setResult(outcome);
    } catch (err) {
      // Not connected, revoked or missing the grant: retrying cannot help until the user acts.
      if (err instanceof HttpError && err.statusCode === 409) {
        await ctx.setResult({ skipped: err.code });
        return;
      }
      throw err;
    }
  },
};

// ---------------------------------------------------------------------------
// Periodic sync: every user who has synced Gmail before gets a sync queued.

export const GMAIL_SYNC_ALL_KIND = 'gmail.sync_all';
export const GMAIL_SYNC_ALL_CRON = '*/15 * * * *';

export async function enqueueGmailSync(db: Db, userId: string): Promise<string> {
  return enqueue(db, GMAIL_SYNC_KIND, {}, { dedupeKey: gmailSyncDedupeKey(userId), userId });
}

export const gmailSyncAllJob: JobHandler<Record<string, never>> = {
  kind: GMAIL_SYNC_ALL_KIND,
  payloadSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  maxAttempts: 1,
  async run(db) {
    const rows = await db
      .select({ userId: syncState.userId })
      .from(syncState)
      .where(eq(syncState.integration, GMAIL_INTEGRATION))
      .all();
    for (const { userId } of rows) {
      const tokens = await readTokens(db, { userId, isAdmin: false });
      const granted = GMAIL_SCOPES.every((s) => tokens?.scopes.includes(s) === true);
      if (granted) await enqueueGmailSync(db, userId);
    }
  },
};
