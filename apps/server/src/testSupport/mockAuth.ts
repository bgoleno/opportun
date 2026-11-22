// The e2e run's sign-ups and its spend of the sign-in rate limits
// (https://github.com/bgoleno/opportun/issues/776).
//
// POST /__mock/auth/users signs a new user up as POST /auth/register does (routes/auth.ts signUp:
// the same account, first session, auth.register audit row and cookies, in the same transaction),
// without the per-IP limiter: the suite registers a user per test, which spent most of the 100
// sign-in attempts an address has per 15 minutes. It never makes the admin: while no account
// exists it refuses (409 no_users_yet), and it creates no admin after (registerUser neverAdmin).
// e2e's registerUser() helper uses it; specs that test sign-up itself keep the form.
//
// Every answered request to a rate-limited auth route, and every re-authentication, is recorded
// with its time, address, account and status. GET /__mock/auth/budget replays the server's own
// buckets over that record (the keys and sizes of routes/auth.ts and lib/reauth.ts) and answers
// each bucket's peak spend; apps/web/e2e's global teardown fails the run when one passed its
// margin, so a spec that signs in once too often fails there, naming the account, rather than a
// later spec failing with "Too many attempts".
//
// Registered under OPPORTUN_AUTH_MOCK (index.ts), so like every mock it is never on in production.
// It keeps no password, cookie, session, token or code, only the route, the address, the account,
// the status and the time; it holds them in memory, at most MAX_ATTEMPTS, and never logs them.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { users } from '../db/schema';
import { IP_LIMIT as REAUTH_IP_LIMIT, USER_LIMIT as REAUTH_USER_LIMIT } from '../lib/reauth';
import { pendingTokenOwner } from '../lib/twoFactor';
import { AUTH_IP_LIMIT, EMAIL_LIMIT, LOGIN_LIMIT, RegisterBody, signUp } from '../routes/auth';
import { OAUTH_IP_LIMIT } from '../routes/oauthLogin';

export const MOCK_AUTH_PATH = '/__mock/auth';

const LOGIN_ROUTE = '/api/v1/auth/login';
const REGISTER_ROUTE = '/api/v1/auth/register';
const VERIFY_ROUTE = '/api/v1/auth/2fa/verify';
const PASSWORD_ROUTE = '/api/v1/auth/password';
/** The routes behind routes/auth.ts's per-IP ceiling (ipLimit). */
const IP_LIMITED: readonly string[] = [LOGIN_ROUTE, REGISTER_ROUTE, VERIFY_ROUTE, PASSWORD_ROUTE];
/** The routes behind routes/oauthLogin.ts's per-IP ceiling (its own ipLimit, `oauth|`). */
const OAUTH_LIMITED: readonly string[] = [
  'GET /api/v1/auth/oauth/:provider/start',
  'POST /api/v1/auth/oauth/:provider/setpw',
  'POST /api/v1/auth/oauth/:provider/link',
  'GET /api/v1/auth/oauth/:provider/callback',
];
/** The routes behind routes/auth.ts's codeLimit, a 2FA code guess per signed-in user. */
const CODE_LIMITED: readonly string[] = [
  'POST /api/v1/auth/2fa/activate',
  'POST /api/v1/auth/2fa/disable',
];
/** As the login schema bounds an email (routes/auth.ts Email): longer is never recorded. */
const MAX_EMAIL = 254;

export interface AuthAttempt {
  /** `METHOD /route`, as the server routes it. */
  route: string;
  /** A re-authentication (lib/reauth.ts's buckets) rather than one of IP_LIMITED. */
  reauth: boolean;
  ip: string;
  /** The signed-in account, on a route that needs one. */
  userId: string | null;
  /** The email a sign-in names, normalized as the login schema does; null elsewhere. */
  email: string | null;
  /** On a 2FA verify, the account its pending token belongs to (null when it names none). */
  owner: string | null;
  status: number;
  at: number;
}

/**
 * The share of a limit one bucket may reach over an e2e run before global-teardown.ts fails it:
 * half, so the suite stays well under every limit (#776). One exception: `oauth|<address>` (30 per
 * 15 minutes) is spent only by oauth.spec.ts, a spec that tests OAuth sign-in itself (start and
 * callback for each GitHub sign-in and link), which #776 exempts from session reuse; it may reach
 * 80%, and the teardown still prints its share so growth stays visible (tl on #829).
 */
export const MARGINS: Readonly<Record<string, number>> = { oauth: 0.8 };
export const DEFAULT_MARGIN = 0.5;

/** True when a bucket's peak passed its kind's margin. */
export function overMargin(b: { kind: string; peak: number; limit: number }): boolean {
  return b.peak > b.limit * (MARGINS[b.kind] ?? DEFAULT_MARGIN);
}

export interface BucketSpend {
  /** Which limiter: ip, login, login-email, 2fa, 2fa-user, 2fa-code, password, reauth, reauth-ip, oauth. */
  kind: string;
  /** The bucket's key, as its limiter keys it (an account's id shown as its email). */
  bucket: string;
  limit: number;
  windowMinutes: number;
  /** The most tokens the bucket was ever down by, refills counted: its peak spend. */
  peak: number;
  /** Requests that spent from it over the run. */
  requests: number;
  /** The share of its limit this bucket may reach (MARGINS). */
  margin: number;
  /** Its peak passed that share. */
  over: boolean;
}

/**
 * A second guard only: behind a proxy on the same host every caller looks local. What keeps this
 * off a real server is that the test mocks are refused under NODE_ENV=production.
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The record keeps the latest this many requests. A full e2e run makes about a hundred, and a
 * window of the largest limit (100 per 15 minutes) is all a replay needs, so the bound never cuts
 * into one; it keeps a long-lived mocked server's memory flat.
 */
export const MAX_ATTEMPTS = 10_000;

function bodyOf(req: FastifyRequest): Record<string, unknown> {
  const body = req.body;
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

/**
 * Every re-authentication route takes the current password as `password` (lib/reauth.ts), and no
 * other route outside IP_LIMITED does; the GitHub unlink, whose password is optional, is the one
 * re-authentication this misses when it is sent without one.
 */
function isReauth(req: FastifyRequest, route: string): boolean {
  return (
    MUTATING.has(req.method) &&
    route.startsWith('/api/v1/') &&
    !IP_LIMITED.includes(route) &&
    typeof bodyOf(req).password === 'string'
  );
}

/**
 * One bucket's peak spend over its requests, in time order: the token bucket of lib/rateLimit.ts
 * (full at the start, refilled continuously, one token a request, none once empty), with a
 * refund given back straight after its own request.
 */
export function peakSpend(
  events: readonly { at: number; refund: boolean }[],
  limit: number,
  windowMs: number,
): number {
  const refillPerMs = limit / windowMs;
  let tokens = limit;
  let last = events[0]?.at ?? 0;
  let peak = 0;
  for (const e of events) {
    tokens = Math.min(limit, tokens + (e.at - last) * refillPerMs);
    last = e.at;
    if (tokens < 1) {
      peak = limit; // refused: the limit was reached
      continue;
    }
    tokens -= 1;
    peak = Math.max(peak, limit - tokens);
    if (e.refund) tokens = Math.min(limit, tokens + 1);
  }
  return Math.round(peak * 100) / 100;
}

interface Spend {
  kind: string;
  key: string;
  limit: { limit: number; windowMs: number };
  refund: boolean;
}

/**
 * The buckets one request spends from, keyed as their limiters key them. Two limiters in
 * routes/auth.ts both key on `2fa-user|<user>` but are separate rateLimit() calls, so separate
 * buckets: the replay names the code limit's `2fa-code|` to keep them apart.
 */
function spends(a: AuthAttempt, who: (userId: string | null) => string): Spend[] {
  const out: Spend[] = [];
  if (OAUTH_LIMITED.includes(a.route)) {
    out.push({ kind: 'oauth', key: `oauth|${a.ip}`, limit: OAUTH_IP_LIMIT, refund: false });
  }
  if (a.reauth) {
    out.push({
      kind: 'reauth-ip',
      key: `reauth-ip|${a.ip}`,
      limit: REAUTH_IP_LIMIT,
      refund: false,
    });
    out.push({
      kind: 'reauth',
      key: `reauth|${who(a.userId)}`,
      limit: REAUTH_USER_LIMIT,
      refund: false,
    });
  }
  if (CODE_LIMITED.includes(a.route)) {
    out.push({
      kind: '2fa-code',
      key: `2fa-code|${who(a.userId)}`,
      limit: LOGIN_LIMIT,
      refund: false,
    });
  }
  const path = a.route.slice(a.route.indexOf(' ') + 1);
  if (!IP_LIMITED.includes(path)) return out;
  out.push({ kind: 'ip', key: `ip|${a.ip}`, limit: AUTH_IP_LIMIT, refund: false });
  if (path === LOGIN_ROUTE) {
    out.push({ kind: 'login', key: `${a.ip}|${a.email ?? ''}`, limit: LOGIN_LIMIT, refund: false });
    // routes/auth.ts refunds the per-account token once the password passes (a 200).
    out.push({
      kind: 'login-email',
      key: `login-email|${a.email ?? ''}`,
      limit: EMAIL_LIMIT,
      refund: a.status === 200,
    });
  } else if (path === VERIFY_ROUTE) {
    out.push({ kind: '2fa', key: `2fa|${a.ip}`, limit: LOGIN_LIMIT, refund: false });
    // Keyed as verifyUserLimit keys it: the pending token's owner, or none plus the address.
    const owner = a.owner === null ? `none|${a.ip}` : who(a.owner);
    out.push({ kind: '2fa-user', key: `2fa-user|${owner}`, limit: LOGIN_LIMIT, refund: false });
  } else if (path === PASSWORD_ROUTE) {
    out.push({
      kind: 'password',
      key: `password|${who(a.userId)}`,
      limit: LOGIN_LIMIT,
      refund: false,
    });
  }
  return out;
}

export async function mockAuthRoutes(app: FastifyInstance): Promise<void> {
  const attempts: AuthAttempt[] = [];
  /** A 2FA verify's token owner, looked up before the handler spends the token. */
  const owners = new WeakMap<FastifyRequest, string | null>();
  const limited = (req: FastifyRequest, url: string): boolean => {
    const route = `${req.method} ${url}`;
    return (
      isReauth(req, url) ||
      (req.method === 'POST' && IP_LIMITED.includes(url)) ||
      OAUTH_LIMITED.includes(route) ||
      CODE_LIMITED.includes(route)
    );
  };
  app.addHook('preHandler', async (req) => {
    if (req.method !== 'POST' || req.routeOptions.url !== VERIFY_ROUTE) return;
    const token = bodyOf(req).pendingToken;
    owners.set(req, typeof token === 'string' ? await pendingTokenOwner(app.db, token) : null);
  });
  // onResponse: a request a limiter refused is answered too, so it is recorded as the limiter
  // counted it, and a sign-in's status says whether its per-account token came back. A 400 is
  // a body the schema refused, which never reached a limiter (they run as preHandlers, after
  // validation), so it is not recorded: nor is its unchecked body kept (sec on #829).
  app.addHook('onResponse', async (req, reply) => {
    const url = req.routeOptions.url;
    if (url === undefined || reply.statusCode === 400 || !limited(req, url)) return;
    const email = bodyOf(req).email;
    if (attempts.length >= MAX_ATTEMPTS) attempts.shift();
    attempts.push({
      route: `${req.method} ${url}`,
      reauth: isReauth(req, url),
      ip: req.ip,
      userId: req.userCtx?.userId ?? null,
      email:
        url === LOGIN_ROUTE && typeof email === 'string'
          ? email.trim().toLowerCase().slice(0, MAX_EMAIL)
          : null,
      owner: owners.get(req) ?? null,
      status: reply.statusCode,
      at: Date.now(),
    });
  });

  app
    .withTypeProvider<ZodTypeProvider>()
    .post(`${MOCK_AUTH_PATH}/users`, { schema: { body: RegisterBody } }, async (req, reply) => {
      if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) {
        return reply.code(403).send({ error: { code: 'loopback_only' } });
      }
      return signUp(req, reply, req.body, { neverAdmin: true });
    });

  app.get(`${MOCK_AUTH_PATH}/attempts`, async (req, reply) => {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) {
      return reply.code(403).send({ error: { code: 'loopback_only' } });
    }
    return reply.send({ attempts });
  });

  app.get(`${MOCK_AUTH_PATH}/budget`, async (req, reply) => {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) {
      return reply.code(403).send({ error: { code: 'loopback_only' } });
    }
    const emails = new Map(
      (await app.db.select({ id: users.id, email: users.email }).from(users)).map((u) => [
        u.id,
        u.email,
      ]),
    );
    const who = (userId: string | null) =>
      userId === null ? 'signed-out' : (emails.get(userId) ?? userId);
    const byKey = new Map<string, { spend: Spend; events: { at: number; refund: boolean }[] }>();
    for (const a of attempts) {
      for (const s of spends(a, who)) {
        const entry = byKey.get(s.key) ?? { spend: s, events: [] };
        entry.events.push({ at: a.at, refund: s.refund });
        byKey.set(s.key, entry);
      }
    }
    const buckets: BucketSpend[] = [...byKey.values()].map(({ spend, events }) => ({
      kind: spend.kind,
      bucket: spend.key,
      limit: spend.limit.limit,
      windowMinutes: spend.limit.windowMs / 60_000,
      peak: peakSpend(events, spend.limit.limit, spend.limit.windowMs),
      requests: events.length,
      margin: MARGINS[spend.kind] ?? DEFAULT_MARGIN,
      over: false,
    }));
    for (const b of buckets) b.over = overMargin(b);
    buckets.sort((x, y) => y.peak / y.limit - x.peak / x.limit);
    return reply.send({ buckets });
  });
}
