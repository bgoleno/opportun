// Device tokens (FR-M5, FR-C5, design section 7 "non-browser clients use bearer device tokens"):
// opaque `odt_` bearer credentials for the Apple Mail connector and the capture extension.
// Shown once at creation, stored as SHA-256, scoped, revocable with immediate effect, and
// accepted ONLY by routes that opt in through deviceRoute(); they never act as a session.
import { createHash, randomBytes } from 'node:crypto';
import { newId } from '@opportun/core';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { lockScope, withTransaction, type Db, type Exec } from '../db/client';
import { deviceTokens, type DeviceTokenScope } from '../db/schema';
import { DEVICE_AUTH_MARK } from '../plugins/security';
import type { UserCtx } from '../repos/base';
import { audit } from './audit';
import { HttpError, notFound, unauthorized } from './errors';
import { whilePasswordCurrent } from './passwordLock';
import { racePoint } from './racePoints';

export const DEVICE_TOKEN_PREFIX = 'odt_';
/**
 * odt_ + 32 random bytes as base64url (43 characters). Exported for the parity test with the
 * extension's and the connector's copies (test/deviceTokenShape.test.ts, #655).
 */
export const DEVICE_TOKEN_SHAPE = /^odt_[A-Za-z0-9_-]{43}$/;
const TOKEN_SHAPE = DEVICE_TOKEN_SHAPE;
/** Skip the last_used_at write when the token was used this recently. */
const TOUCH_INTERVAL_MS = 60 * 1000;

/** The caller on a device route: always a plain user, never an admin. */
export interface DeviceCtx extends UserCtx {
  isAdmin: false;
  tokenId: string;
  scopes: DeviceTokenScope[];
  /** The demo visitor who minted the token (#545), or null (off the demo, or minted before). */
  actor: string | null;
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

/**
 * Creates a token for the caller; the plaintext is returned here and nowhere else, ever.
 *
 * With `passwordHash` (the hash the caller's password was just proven against), the insert happens
 * only while that is still the user's hash, under the lock a password change and a reset take
 * (passwordScope): a change that revokes tokens, or a reset, that commits during the check wins,
 * and this answers 403 having created nothing (#539).
 *
 * With `maxActive`, the caller keeps at most that many unrevoked tokens: when the new one would
 * pass it, the oldest are revoked to make room, and each revoke is audited as a manual one is,
 * with `ip` (tl on #550: a visitor on a shared demo account always gets a token, and the one least
 * likely still in use goes).
 *
 * Both happen in one transaction, in this order (sec on #557): the password lock, the hash check,
 * then the tokens' lock, the revokes and the insert. A 403 for a changed password therefore
 * revokes nothing, and two mints at once cannot leave more than `maxActive`.
 */
export async function createDeviceToken(
  db: Db,
  ctx: UserCtx,
  input: { name: string; scopes: DeviceTokenScope[] },
  opts: { passwordHash?: string; maxActive?: number; ip?: string; actor?: string | null } = {},
): Promise<{ meta: DeviceTokenMeta; token: string }> {
  const token = DEVICE_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const now = Date.now();
  const scopes = [...new Set(input.scopes)];
  const { passwordHash, maxActive } = opts;
  const actor = opts.actor ?? null;
  if (passwordHash === undefined && maxActive === undefined) {
    return { meta: await insertToken(db, ctx, input.name, token, scopes, now, actor), token };
  }
  // The cap (#550), then the insert, in whichever transaction holds the write.
  const write = async (tx: Exec) => {
    if (maxActive !== undefined) {
      await lockScope(tx, `device_tokens:${ctx.userId}`);
      const active = await tx
        .select({ id: deviceTokens.id, name: deviceTokens.name })
        .from(deviceTokens)
        .where(and(eq(deviceTokens.userId, ctx.userId), isNull(deviceTokens.revokedAt)))
        .orderBy(asc(deviceTokens.createdAt), asc(deviceTokens.id))
        .all();
      // Room for the new one: the oldest go first.
      for (const old of active.slice(0, Math.max(active.length - maxActive + 1, 0))) {
        await tx
          .update(deviceTokens)
          .set({ revokedAt: now, updatedAt: now })
          .where(and(eq(deviceTokens.id, old.id), isNull(deviceTokens.revokedAt)))
          .run();
        await audit(tx, 'device_token.revoked', {
          userId: ctx.userId,
          ...(opts.ip === undefined ? {} : { ip: opts.ip }),
          detail: { id: old.id, name: old.name },
        });
      }
    }
    return { meta: await insertToken(tx, ctx, input.name, token, scopes, now, actor), token };
  };
  if (passwordHash === undefined) return await withTransaction(db, write);
  // Only while the hash the password was proven against is still the user's, under the lock a
  // change and a reset take (#539, lib/passwordLock.ts). The race point is inside the lock, after
  // the check (test/deviceTokenPasswordRace.test.ts parks there).
  const created = await whilePasswordCurrent(db, ctx.userId, passwordHash, write, {
    point: 'deviceTokens.create.locked',
  });
  if (!created.current) {
    // A sentence written for the user to read (#743), so marked for the client (#750).
    throw new HttpError(
      403,
      'password_changed',
      'Your password changed while this was being checked. Sign in again and try once more.',
      undefined,
      { userFacing: true },
    );
  }
  return created.value;
}

async function insertToken(
  db: Exec,
  ctx: UserCtx,
  name: string,
  token: string,
  scopes: DeviceTokenScope[],
  now: number,
  actor: string | null,
): Promise<DeviceTokenMeta> {
  return await db
    .insert(deviceTokens)
    .values({
      id: newId(),
      userId: ctx.userId,
      name,
      tokenHash: hashDeviceToken(token),
      scopes,
      actor,
      createdAt: now,
      updatedAt: now,
    })
    .returning(META_COLUMNS)
    .get();
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
 * Revokes every active device token of `userId` and returns how many: on a password change when
 * the user asks (#523), in the same transaction as the password update, as the admin and CLI reset
 * does (passwordReset.ts).
 */
export async function revokeAllDeviceTokens(db: Exec, userId: string): Promise<number> {
  const now = Date.now();
  const rows = await db
    .update(deviceTokens)
    .set({ revokedAt: now, updatedAt: now })
    .where(and(eq(deviceTokens.userId, userId), isNull(deviceTokens.revokedAt)))
    .returning({ id: deviceTokens.id })
    .all();
  return rows.length;
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
      actor: deviceTokens.actor,
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
    ctx: {
      userId: row.userId,
      isAdmin: false,
      tokenId: row.id,
      scopes: row.scopes,
      actor: row.actor,
    },
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
 *
 * Telemetry: the device user reaches the trace context (design 14.6) only if the route also
 * authenticates in `onRequest`, as every connector route does today (`onRequest:
 * [requireDeviceToken(...), ...]`). plugins/obsHttp.ts puts the user in the context in
 * preValidation, which runs after `onRequest` but before this preHandler: a route that
 * authenticates here alone gets no user in its trace (#371, tl on #368).
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
