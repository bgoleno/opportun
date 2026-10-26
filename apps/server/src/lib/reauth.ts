// Re-authentication for credential changes (security review L3): enrolling, activating or
// disabling 2FA and minting a device token all take the CURRENT password, so a hijacked
// session cookie alone can neither lock the owner out nor mint push tokens. Same Argon2id
// path (pepper included) as login, and the same budget: 10 tries per 15 minutes per user,
// 100 per IP, shared across every re-auth route of one app.
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { Db } from '../db/client';
import { users } from '../db/schema';
import { audit } from './audit';
import { NO_PEPPERS, verifyPasswordWithUpgrade } from './passwords';
import { rateLimit } from './rateLimit';

const USER_LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 };
const IP_LIMIT = { limit: 100, windowMs: 15 * 60 * 1000 };

const limiters = new WeakMap<Db, preHandlerAsyncHookHandler[]>();

/** The re-auth rate limits for this app's database (one shared set of buckets). */
export function reauthLimits(db: Db): preHandlerAsyncHookHandler[] {
  let found = limiters.get(db);
  if (found === undefined) {
    found = [
      rateLimit({ keyFn: (req) => `reauth-ip|${req.ip}`, ...IP_LIMIT }),
      rateLimit({ keyFn: (req) => `reauth|${req.userCtx?.userId ?? req.ip}`, ...USER_LIMIT }),
    ];
    limiters.set(db, found);
  }
  return found;
}

/**
 * True when `password` is the user's current password. On a mismatch it audits
 * auth.reauth_failed (with the action, never the password) and answers 403
 * invalid_password, which callers return as-is: 403, not 401, so the SPA does not read a
 * typo as a lost session.
 */
export async function confirmPassword(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: { userId: string; password: string; action: string },
): Promise<boolean> {
  const db = req.server.db;
  const row = await db
    .select({ hash: users.passwordHash })
    .from(users)
    .where(eq(users.id, opts.userId))
    .get();
  const peppers = req.server.config.peppers ?? NO_PEPPERS;
  const ok =
    row !== undefined && (await verifyPasswordWithUpgrade(row.hash, opts.password, peppers)).ok;
  if (ok) return true;
  await audit(db, 'auth.reauth_failed', {
    userId: opts.userId,
    ip: req.ip,
    detail: { action: opts.action },
  });
  await reply.code(403).send({ error: { code: 'invalid_password' } });
  return false;
}
