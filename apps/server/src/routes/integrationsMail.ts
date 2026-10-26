// Mail ingestion API (FR-M1; Apple Mail status for FR-M5). Sync runs as a job; status reports the read-only grant, the last
// sync and how many messages are stored. Nothing here can change the user's mailbox (FR-M7).
import type { CommChannel } from '@opportun/core';
import { and, count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  GMAIL_ADDRESS_SETTING,
  gmailLookbackDays,
  gmailQueryForDays,
  writeGmailQuery,
} from '../adapters/gmail';
import { communications } from '../db/schema';
import { audit } from '../lib/audit';
import { listDeviceTokens } from '../lib/deviceTokens';
import { HttpError } from '../lib/errors';
import { GMAIL_SCOPES, readTokens } from '../lib/google';
import { MAX_LOOKBACK_DAYS } from '../lib/lookback';
import { requireUser, type UserCtx } from '../repos/base';
import { getSyncState, putSyncState } from '../repos/communications';
import { readUserSetting } from '../repos/userSettings';
import type { Db } from '../db/client';
import { enqueueGmailSync, GMAIL_INTEGRATION } from '../jobs/gmailSync';
import { APPLE_MAIL_INTEGRATION } from '../jobs/mailIngest';
import { withTransaction } from '../db/client';

/** The synced mailbox's address, stored by the sync (adapters/gmail). */
async function gmailAccountAddress(db: Db, ctx: UserCtx): Promise<string | null> {
  const stored = await readUserSetting(db, ctx, GMAIL_ADDRESS_SETTING, z.string(), '');
  return stored.length === 0 ? null : stored;
}

const StatusSchema = z.object({
  connected: z.boolean(),
  lastSyncAt: z.number().int().nullable(),
  count: z.number().int().nonnegative(),
  status: z.string().nullable(),
  /** The sync window in days; null when the gmail_query setting was hand-edited. */
  lookbackDays: z.number().int().nullable(),
  /**
   * The synced mailbox's address, which the deep link back to a message needs for `authuser`.
   * Null until a sync has read the profile, and the link then falls back to the browser's first
   * Google account rather than guessing.
   */
  accountEmail: z.string().nullable(),
});
const AppleMailStatusSchema = z.object({
  /**
   * The connector has delivered a batch (the server never reaches the Mac) and an unrevoked
   * mail:push token is left for it to deliver the next one with.
   */
  connected: z.boolean(),
  lastSyncAt: z.number().int().nullable(),
  status: z.string().nullable(),
  count: z.number().int().nonnegative(),
  /** Set when connected but the last batch is over a day old: the connector may have stopped. */
  staleHint: z.string().nullable(),
});
/** A connector syncs every few minutes; a day of silence means it is not running. */
const APPLE_MAIL_STALE_MS = 24 * 60 * 60 * 1000;
const APPLE_MAIL_STALE_HINT =
  'No mail from the connector in over 24 hours. Check that it is running on your Mac.';
const LookbackBody = z.object({ days: z.number().int().min(1).max(MAX_LOOKBACK_DAYS) }).strict();

export async function integrationsMailRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  async function channelCount(ctx: UserCtx, channel: CommChannel): Promise<number> {
    return (
      (
        await db
          .select({ n: count() })
          .from(communications)
          .where(and(eq(communications.userId, ctx.userId), eq(communications.channel, channel)))
          .get()
      )?.n ?? 0
    );
  }

  async function gmailGranted(ctx: UserCtx): Promise<boolean> {
    const tokens = await readTokens(db, ctx);
    if (tokens === undefined || (tokens.refreshToken === null && tokens.accessToken === null)) {
      return false;
    }
    return GMAIL_SCOPES.every((s) => tokens.scopes.includes(s));
  }

  api.post(
    '/integrations/gmail/sync',
    { schema: { response: { 202: z.object({ jobId: z.string() }) } } },
    async (req, reply) => {
      const ctx = requireUser(req);
      if (!(await gmailGranted(ctx))) throw new HttpError(409, 'gmail_not_connected');
      const jobId = await enqueueGmailSync(db, ctx.userId);
      return reply.code(202).send({ jobId });
    },
  );

  api.get('/integrations/gmail', { schema: { response: { 200: StatusSchema } } }, async (req) => {
    const ctx = requireUser(req);
    const state = await getSyncState(db, ctx, GMAIL_INTEGRATION);
    const n = await channelCount(ctx, 'gmail');
    return {
      connected: await gmailGranted(ctx),
      lastSyncAt: state?.lastSyncAt ?? null,
      count: n,
      status: state?.status ?? null,
      lookbackDays: await gmailLookbackDays(db, ctx),
      accountEmail: await gmailAccountAddress(db, ctx),
    };
  });

  api.get(
    '/integrations/apple-mail',
    { schema: { response: { 200: AppleMailStatusSchema } } },
    async (req) => {
      const ctx = requireUser(req);
      const state = await getSyncState(db, ctx, APPLE_MAIL_INTEGRATION);
      const lastSyncAt = state?.lastSyncAt ?? null;
      const hasToken = (await listDeviceTokens(db, ctx)).some(
        (t) => t.revokedAt === null && t.scopes.includes('mail:push'),
      );
      const connected = lastSyncAt !== null && hasToken;
      const stale = connected && Date.now() - lastSyncAt > APPLE_MAIL_STALE_MS;
      return {
        connected,
        lastSyncAt,
        status: state?.status ?? null,
        count: await channelCount(ctx, 'apple_mail'),
        staleHint: stale ? APPLE_MAIL_STALE_HINT : null,
      };
    },
  );

  api.put(
    '/integrations/gmail/lookback',
    { schema: { body: LookbackBody, response: { 200: z.object({ lookbackDays: z.number() }) } } },
    async (req) => {
      const ctx = requireUser(req);
      const days = req.body.days;
      // The cursor resets so the next sync re-lists the whole new window. Widening pulls the
      // older mail in; narrowing is non-destructive (already-imported mail stays, upserts
      // dedupe the rest). The classifier only runs for messages seen for the first time.
      await withTransaction(db, async (tx) => {
        await writeGmailQuery(tx, ctx, gmailQueryForDays(days));
        await putSyncState(tx, ctx, GMAIL_INTEGRATION, { cursor: null });
      });
      await audit(db, 'gmail.lookback_set', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { days },
      });
      return { lookbackDays: days };
    },
  );
}
