// Whether each mail channel is connected, shared by the integration status cards and the setup
// checklist (FR-U12) so "connected" has one definition rather than two that can drift.
import type { Db } from '../db/client';
import { getSyncState } from '../repos/communications';
import type { UserCtx } from '../repos/base';
import { APPLE_MAIL_INTEGRATION } from '../jobs/mailIngest';
import { listDeviceTokens } from './deviceTokens';
import { GMAIL_SCOPES, readTokens } from './google';

/** Google tokens are stored and carry every Gmail scope. */
export async function gmailGranted(db: Db, ctx: UserCtx): Promise<boolean> {
  const tokens = await readTokens(db, ctx);
  if (tokens === undefined || (tokens.refreshToken === null && tokens.accessToken === null)) {
    return false;
  }
  return GMAIL_SCOPES.every((s) => tokens.scopes.includes(s));
}

/**
 * The connector has delivered a batch (the server never reaches the Mac) and an unrevoked
 * mail:push token is left for it to deliver the next one with.
 */
export async function appleMailState(
  db: Db,
  ctx: UserCtx,
): Promise<{ connected: boolean; lastSyncAt: number | null; status: string | null }> {
  const state = await getSyncState(db, ctx, APPLE_MAIL_INTEGRATION);
  const lastSyncAt = state?.lastSyncAt ?? null;
  const hasToken = (await listDeviceTokens(db, ctx)).some(
    (t) => t.revokedAt === null && t.scopes.includes('mail:push'),
  );
  return { connected: lastSyncAt !== null && hasToken, lastSyncAt, status: state?.status ?? null };
}
