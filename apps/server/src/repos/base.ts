// Repository conventions (FR-S5): every repo function signature starts (db: Db, ctx: UserCtx,
// ...) and filters by ctx.userId, so a handler cannot query another user's rows by accident.
import type { FastifyRequest } from 'fastify';
import { forbidden, unauthorized } from '../lib/errors';

export type { Db, Exec } from '../db/client';

/** The authenticated caller. Repositories take this, never a raw user id (FR-S5). */
export interface UserCtx {
  userId: string;
  isAdmin: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved from the session cookie on /api requests; null when not signed in. */
    userCtx: UserCtx | null;
  }
  interface FastifyInstance {
    requireUser: typeof requireUser;
  }
}

/** The caller's context; throws a 401 HttpError when the request has no valid session. */
export function requireUser(req: FastifyRequest): UserCtx {
  const ctx = req.userCtx;
  if (ctx === null || ctx === undefined) throw unauthorized();
  return ctx;
}

/**
 * The caller's context when they are an admin: 401 with no valid session, as requireUser, and 403
 * `forbidden` for anyone else. Every admin route's check (#767): one place, one answer.
 */
export function requireAdmin(req: FastifyRequest): UserCtx {
  const ctx = requireUser(req);
  if (!ctx.isAdmin) throw forbidden();
  return ctx;
}
