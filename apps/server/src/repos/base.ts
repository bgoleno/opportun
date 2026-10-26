// Repository conventions (FR-S5): every repo function signature starts (db: Db, ctx: UserCtx,
// ...) and filters by ctx.userId, so a handler cannot query another user's rows by accident.
import type { FastifyRequest } from 'fastify';
import { unauthorized } from '../lib/errors';

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
