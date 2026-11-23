// Repository conventions (FR-S5): every repo function signature starts (db: Db, ctx: UserCtx,
// ...) and filters by ctx.userId, so a handler cannot query another user's rows by accident.
import type { FastifyRequest } from 'fastify';
import { eq, sql, type AnyColumn, type SQL } from 'drizzle-orm';
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

/** Whose rows a query reads: the caller (a UserCtx), or a user named by id. */
export type Owner = { readonly userId: string };

/**
 * The one per-user ownership predicate (https://github.com/bgoleno/opportun/issues/768;
 * docs/architecture.md 8.1): the row's user column is the owner's id. Every repo query that reads
 * a user's own rows goes through this (or ownedSql), so a later tenancy change adds its second
 * scope key in one place. test/ownershipPredicate.test.ts fails on an inline one in repos/.
 */
export function ownedBy(column: AnyColumn, owner: Owner): SQL {
  return eq(column, owner.userId);
}

/**
 * ownedBy for hand-written SQL: `column` is the table's user_id as the statement names it (an
 * alias and a column, written in this repo's source, never input), and the id is a bound value.
 */
export function ownedSql(column: string, owner: Owner): SQL {
  return sql`${sql.raw(column)} = ${owner.userId}`;
}
