// OAuth sign-in state (FR-S4, plan Review Focus 2). The state parameter is an HMAC-signed,
// ten-minute, single-use payload naming the provider and the mode, and its MAC also covers:
//   - a random browser binding kept in an HttpOnly cookie set by /start, so a callback URL
//     minted in an attacker's browser cannot sign a victim in (login CSRF);
//   - for mode=link and mode=setpw, the id of the session that started the flow, so a link
//     (or a password-set confirmation) lands only on the session that asked for it.
// The PKCE verifier is derived from the binding and the nonce, so it is never stored and
// never leaves the server; only its S256 challenge goes to the provider.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db/client';
import { OAUTH_PROVIDERS, type OAuthProvider } from './oauthProviders';

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
/**
 * login: sign in. link: add a provider to the signed-in account. setpw: a fresh provider
 * confirmation that lets an account created by OAuth sign-in set its first password (M-1).
 */
export const OAUTH_MODES = ['login', 'link', 'setpw'] as const;
export type OAuthMode = (typeof OAUTH_MODES)[number];

const Payload = z.object({
  n: z.string().min(16).max(64),
  e: z.number().int(),
  p: z.enum(OAUTH_PROVIDERS),
  m: z.enum(OAUTH_MODES),
});

/** A purpose-bound key: the master key is never used directly as an HMAC key. */
function subKey(masterKey: Buffer, purpose: string): Buffer {
  return createHmac('sha256', masterKey).update(`opportun:oauth-login-${purpose}:v1`).digest();
}

/** The session's stable id (what the sessions table stores): SHA-256 hex of the cookie. */
export function sessionIdOf(sessionToken: string): string {
  return createHash('sha256').update(sessionToken).digest('hex');
}

/** A fresh browser binding for the HttpOnly cookie. */
export function newBinding(): string {
  return randomBytes(32).toString('base64url');
}

function mac(masterKey: Buffer, body: string, binding: string, sessionId: string): Buffer {
  return createHmac('sha256', subKey(masterKey, 'state'))
    .update(`${body}|${binding}|${sessionId}`)
    .digest();
}

/** RFC 7636 verifier (43 base64url characters) for this flow. */
export function pkceVerifier(masterKey: Buffer, binding: string, nonce: string): string {
  return createHmac('sha256', subKey(masterKey, 'pkce'))
    .update(`${binding}|${nonce}`)
    .digest('base64url');
}

export interface IssuedState {
  state: string;
  nonce: string;
}

export function signOAuthState(
  masterKey: Buffer,
  opts: { provider: OAuthProvider; mode: OAuthMode; binding: string; sessionId: string },
  now = Date.now(),
): IssuedState {
  const nonce = randomBytes(16).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({ n: nonce, e: now + OAUTH_STATE_TTL_MS, p: opts.provider, m: opts.mode }),
  ).toString('base64url');
  const sig = mac(masterKey, body, opts.binding, opts.sessionId).toString('base64url');
  return { state: `${body}.${sig}`, nonce };
}

export interface VerifiedState {
  mode: OAuthMode;
  nonce: string;
}

/**
 * The mode and nonce the state was issued with, or null when it is forged, expired, for
 * another provider, or not bound to this browser (and, for link, this session). The mode is
 * read from the payload before the MAC check only to pick which session id to check against;
 * the MAC covers it, so a flipped mode fails either way.
 */
export function verifyOAuthState(
  masterKey: Buffer,
  state: string,
  opts: { provider: OAuthProvider; binding: string; sessionId: string | null },
  now = Date.now(),
): VerifiedState | null {
  if (state.length > 1024 || opts.binding.length === 0) return null;
  const dot = state.indexOf('.');
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  let payload: z.infer<typeof Payload>;
  try {
    const parsed = Payload.safeParse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
    if (!parsed.success) return null;
    payload = parsed.data;
  } catch {
    return null;
  }
  const sessionId = payload.m === 'login' ? '' : opts.sessionId;
  if (sessionId === null) return null;
  const given = Buffer.from(state.slice(dot + 1), 'base64url');
  const expected = mac(masterKey, body, opts.binding, sessionId);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (payload.e < now || payload.p !== opts.provider) return null;
  return { mode: payload.m, nonce: payload.n };
}

// Single use: a nonce is spent on its first callback. In process by design (single node, like
// the rate-limit buckets); entries go once their state would have expired anyway. Shared with
// the Google connection flow (lib/google.ts), whose state carries a nonce of its own and has
// the same ten minute life.
const spent = new WeakMap<Db, Map<string, number>>();

/** True the first time a nonce is presented (and records it); false on every replay. */
export function spendNonce(db: Db, nonce: string, now = Date.now()): boolean {
  let seen = spent.get(db);
  if (seen === undefined) {
    seen = new Map();
    spent.set(db, seen);
  }
  for (const [n, expires] of seen) if (expires < now) seen.delete(n);
  if (seen.has(nonce)) return false;
  seen.set(nonce, now + OAUTH_STATE_TTL_MS);
  return true;
}

// ---------------------------------------------------------------------------
// Password-set grant (M-1). An account created by OAuth sign-in has no password, so setting
// its first one cannot be confirmed with a password; a stolen session cookie alone must not
// be able to mint that permanent credential. A setpw round trip through the provider account
// already linked to the user stamps this grant: five minutes, single use, bound to the
// session that did the round trip (and its user). In process, like the nonce store.

export const PASSWORD_SET_GRANT_TTL_MS = 5 * 60 * 1000;

const grants = new WeakMap<Db, Map<string, { userId: string; expiresAt: number }>>();

function grantsFor(db: Db): Map<string, { userId: string; expiresAt: number }> {
  let found = grants.get(db);
  if (found === undefined) {
    found = new Map();
    grants.set(db, found);
  }
  return found;
}

export function grantPasswordSet(
  db: Db,
  sessionId: string,
  userId: string,
  now = Date.now(),
): void {
  const map = grantsFor(db);
  for (const [id, g] of map) if (g.expiresAt <= now) map.delete(id);
  map.set(sessionId, { userId, expiresAt: now + PASSWORD_SET_GRANT_TTL_MS });
}

/** True once for a live grant of this session and user; the grant is gone afterwards. */
export function consumePasswordSetGrant(
  db: Db,
  sessionId: string,
  userId: string,
  now = Date.now(),
): boolean {
  const map = grantsFor(db);
  const grant = map.get(sessionId);
  if (grant === undefined || grant.userId !== userId) return false;
  map.delete(sessionId);
  return grant.expiresAt > now;
}
