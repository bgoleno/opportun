// Device tokens (FR-M5, FR-C5, design section 7 "non-browser clients use bearer device tokens"):
// opaque `odt_` bearer credentials for the Apple Mail connector and the capture extension.
// Shown once at creation, stored as SHA-256, scoped, revocable with immediate effect, and
// accepted ONLY by routes that opt in through deviceRoute(); they never act as a session.
import { createHash, randomBytes } from 'node:crypto';
import { newId } from '@opportun/core';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { Db } from '../db/client';
import { deviceTokens, type DeviceTokenScope } from '../db/schema';
import { DEVICE_AUTH_MARK } from '../plugins/security';
import type { UserCtx } from '../repos/base';
import { notFound, unauthorized } from './errors';
import { racePoint } from './racePoints';

export const DEVICE_TOKEN_PREFIX = 'odt_';
/** odt_ + 32 random bytes as base64url (43 characters). */
const TOKEN_SHAPE = /^odt_[A-Za-z0-9_-]{43}$/;
/** Skip the last_used_at write when the token was used this recently. */
const TOUCH_INTERVAL_MS = 60 * 1000;

/** The caller on a device route: always a plain user, never an admin. */
export interface DeviceCtx extends UserCtx {
  isAdmin: false;
  tokenId: string;
  scopes: DeviceTokenScope[];
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by a deviceRoute preHandler; null everywhere else. */
    deviceCtx: DeviceCtx | null;
  }
}

export interface DeviceTokenMeta {
  id: string;
  name: string;
  scopes: DeviceTokenScope[];
  lastUsedAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

const META_COLUMNS = {
  id: deviceTokens.id,
  name: deviceTokens.name,
  scopes: deviceTokens.scopes,
  lastUsedAt: deviceTokens.lastUsedAt,
  revokedAt: deviceTokens.revokedAt,
  createdAt: deviceTokens.createdAt,
};

export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Creates a token for the caller; the plaintext is returned here and nowhere else, ever. */
export async function createDeviceToken(
  db: Db,
  ctx: UserCtx,
  input: { name: string; scopes: DeviceTokenScope[] },
): Promise<{ meta: DeviceTokenMeta; token: string }> {
  const token = DEVICE_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const now = Date.now();
  const scopes = [...new Set(input.scopes)];
  const meta = await db
    .insert(deviceTokens)
    .values({
      id: newId(),
      userId: ctx.userId,
      name: input.name,
      tokenHash: hashDeviceToken(token),
      scopes,
      createdAt: now,
      updatedAt: now,
    })
    .returning(META_COLUMNS)
    .get();
  return { meta, token };
}

export async function listDeviceTokens(db: Db, ctx: UserCtx): Promise<DeviceTokenMeta[]> {
  return await db
    .select(META_COLUMNS)
    .from(deviceTokens)
    .where(eq(deviceTokens.userId, ctx.userId))
    .orderBy(desc(deviceTokens.createdAt), desc(deviceTokens.id))
    .all();
}

/** Revokes the caller's own token (idempotent: the first revocation time sticks); 404 otherwise. */
export async function revokeDeviceToken(
  db: Db,
  ctx: UserCtx,
  id: string,
): Promise<DeviceTokenMeta> {
  const owned = and(eq(deviceTokens.id, id), eq(deviceTokens.userId, ctx.userId));
  const row = await db.select(META_COLUMNS).from(deviceTokens).where(owned).get();
  if (row === undefined) throw notFound();
  if (row.revokedAt !== null) return row;
  await racePoint('deviceTokens.revoke');
  const now = Date.now();
  // Only an unrevoked token: of two concurrent revokes the first time sticks.
  const revoked = await db
    .update(deviceTokens)
    .set({ revokedAt: now, updatedAt: now })
    .where(and(owned, isNull(deviceTokens.revokedAt)))
    .returning(META_COLUMNS)
    .get();
  if (revoked !== undefined) return revoked;
  const current = await db.select(META_COLUMNS).from(deviceTokens).where(owned).get();
  if (current === undefined) throw notFound();
  return current;
}

/**
 * Renames the caller's own token; 404 otherwise. The name is a label for the person reading
 * the list (design D6: the setup dialog proposes "<Browser> · <display name>", and someone
 * running two of the same browser needs to tell them apart). It grants nothing, so unlike
 * creating a token this needs no password.
 */
export async function renameDeviceToken(
  db: Db,
  ctx: UserCtx,
  id: string,
  name: string,
): Promise<DeviceTokenMeta> {
  const owned = and(eq(deviceTokens.id, id), eq(deviceTokens.userId, ctx.userId));
  const renamed = await db
    .update(deviceTokens)
    .set({ name, updatedAt: Date.now() })
    .where(owned)
    .returning(META_COLUMNS)
    .get();
  if (renamed === undefined) throw notFound();
  return renamed;
}

type AuthResult = { ok: true; ctx: DeviceCtx } | { ok: false; status: 401 | 403 };

/**
 * Resolves a presented token for `scope`. Looked up on every request (no cache), so a revoked
 * token fails on its next use. Unknown, malformed and revoked tokens are all a plain 401.
 */
export async function authenticateDeviceToken(
  db: Db,
  token: string,
  scope: DeviceTokenScope,
): Promise<AuthResult> {
  if (!TOKEN_SHAPE.test(token)) return { ok: false, status: 401 };
  const row = await db
    .select({
      id: deviceTokens.id,
      userId: deviceTokens.userId,
      scopes: deviceTokens.scopes,
      lastUsedAt: deviceTokens.lastUsedAt,
      revokedAt: deviceTokens.revokedAt,
    })
    .from(deviceTokens)
    .where(eq(deviceTokens.tokenHash, hashDeviceToken(token)))
    .get();
  if (row === undefined || row.revokedAt !== null) return { ok: false, status: 401 };
  if (!row.scopes.includes(scope)) return { ok: false, status: 403 };
  const now = Date.now();
  if (row.lastUsedAt === null || now - row.lastUsedAt >= TOUCH_INTERVAL_MS) {
    await db.update(deviceTokens).set({ lastUsedAt: now }).where(eq(deviceTokens.id, row.id)).run();
  }
  return {
    ok: true,
    ctx: { userId: row.userId, isAdmin: false, tokenId: row.id, scopes: row.scopes },
  };
}

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const m = /^Bearer ([^\s]+)$/.exec(header);
  return m === null ? null : m[1]!;
}

function refuse(reply: FastifyReply, status: 401 | 403) {
  if (status === 401) reply.header('www-authenticate', 'Bearer');
  return reply
    .code(status)
    .send({ error: { code: status === 401 ? 'invalid_token' : 'insufficient_scope' } });
}

/**
 * Fastify preHandler for connector routes: `Authorization: Bearer odt_...` with `scope`, or
 * 401/403. Sets req.deviceCtx. Session cookies are irrelevant here (see deviceRoute).
 */
export function requireDeviceToken(scope: DeviceTokenScope): preHandlerAsyncHookHandler {
  const handler: preHandlerAsyncHookHandler = async function deviceAuth(req, reply) {
    const presented = bearerToken(req);
    if (presented === null) return refuse(reply, 401);
    const result = await authenticateDeviceToken(req.server.db, presented, scope);
    if (!result.ok) return refuse(reply, result.status);
    req.deviceCtx = result.ctx;
  };
  Object.defineProperty(handler, DEVICE_AUTH_MARK, { value: true });
  return handler;
}

/**
 * Route options for a device-token route: spread into the route definition. It marks the
 * route deviceAuth (no CSRF, which guards cookies; and no session resolution, so a handler
 * can never mistake a cookie for the device's identity) and installs requireDeviceToken.
 * The security plugin refuses a deviceAuth route without this preHandler.
 */
export function deviceRoute(scope: DeviceTokenScope): {
  config: { deviceAuth: true };
  preHandler: preHandlerAsyncHookHandler;
} {
  return { config: { deviceAuth: true }, preHandler: requireDeviceToken(scope) };
}

/** The device caller; throws a 401 HttpError when the route did not authenticate one. */
export function requireDevice(req: FastifyRequest): DeviceCtx {
  const ctx = req.deviceCtx;
  if (ctx === null || ctx === undefined) throw unauthorized();
  return ctx;
}
