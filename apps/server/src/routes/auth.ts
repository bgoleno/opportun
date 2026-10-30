// Local auth (FR-S1, FR-S2, FR-S3, NFR-SEC3): registration lock, login (two-step when TOTP 2FA
// is on), 2FA enrollment, logout, me, password change, and the admin surface: registration
// toggle, users list and password reset.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, asc, eq, inArray, max } from 'drizzle-orm';
import QRCode from 'qrcode';
import { z } from 'zod';
import { isUniqueViolation } from '../db/client';
import { auditLog, settings, users } from '../db/schema';
import { audit } from '../lib/audit';
import { racePoint } from '../lib/racePoints';
import { resetUserPassword } from '../lib/passwordReset';
import {
  canRegister,
  isRegistrationOpen,
  registerUser,
  REGISTRATION_OPEN_KEY,
  RegistrationClosedError,
} from '../lib/registration';
import {
  DUMMY_HASH,
  hasUsablePassword,
  hashPassword,
  hashVersion,
  NO_PEPPERS,
  verifyPasswordWithUpgrade,
} from '../lib/passwords';
import { rateLimit } from '../lib/rateLimit';
import { confirmPassword, reauthLimits } from '../lib/reauth';
import { consumePasswordSetGrant, sessionIdOf } from '../lib/oauthState';
import { decryptSecret, encryptSecret } from '../lib/secretBox';
import { createSession, destroyAllSessions, destroySession } from '../lib/sessions';
import { generateTotpSecret, matchTotpStep, otpauthUrl } from '../lib/totp';
import {
  checkSecondFactor,
  clearTwoFactor,
  createPendingToken,
  generateRecoveryCodes,
  hashRecoveryCode,
  pendingTokenOwner,
  redeemPendingToken,
} from '../lib/twoFactor';
import { clearCsrfCookie, isSecureRequest, issueCsrfCookie } from '../plugins/security';
import { requireUser } from '../repos/base';

export const SESSION_COOKIE = 'opportun_session';
export { REGISTRATION_OPEN_KEY };

const LOGIN_LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 };
/**
 * Per-account backstop against a distributed brute force (issue #333). Once the trusted-proxy
 * fix makes req.ip real, an attacker with many source IPs can still make LOGIN_LIMIT.limit
 * attempts PER IP against one account, so a limit keyed on the account itself is the only thing
 * that caps the account-wide total. Keyed on the attempted email BEFORE any user lookup, so an
 * unknown address throttles identically to a real one and the limiter is not a user-enumeration
 * oracle.
 *
 * The ceiling is deliberately higher than the per-(IP,email) LOGIN_LIMIT: one user fat-fingering
 * a password across a couple of devices must never trip it, while a distributed run against one
 * account does. Rejected alternatives: per-account exponential backoff and a global failure
 * threshold, both of which avoid the lockout cost below but are materially more code and state; a
 * hard cap at a high ceiling was chosen as the smaller change. Accepted cost: this is a targeted
 * account-lockout vector (anyone can drain a victim's bucket by failing logins against their
 * email), bounded and self-healing within windowMs, and it matters more once the instance is
 * public (issue #232) than on a single-user LAN today.
 */
const EMAIL_LIMIT = { limit: 30, windowMs: 15 * 60 * 1000 };
/** Coarse per-IP ceiling on auth attempts across all emails (design section 7). */
const AUTH_IP_LIMIT = { limit: 100, windowMs: 15 * 60 * 1000 };

const Email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const NewPassword = z.string().min(12).max(1024);

const RegisterBody = z.object({
  email: Email,
  password: NewPassword,
  displayName: z.string().trim().min(1).max(100),
});
const LoginBody = z.object({
  email: z.string().trim().toLowerCase().min(1).max(254),
  password: z.string().min(1).max(1024),
});
const PasswordBody = z.object({
  /**
   * Required, except for an account created by OAuth sign-in that has no password yet
   * (users.password_hash is the unusable placeholder): that sets its first one.
   */
  current: z.string().min(1).max(1024).optional(),
  next: NewPassword,
});
const RegistrationBody = z.object({ open: z.boolean() });

const TotpCode = z.string().trim().min(1).max(32);
const RecoveryCode = z.string().trim().min(1).max(64);
/** Exactly one second factor: a TOTP code or a recovery code. */
const SecondFactorShape = z.object({
  code: TotpCode.optional(),
  recoveryCode: RecoveryCode.optional(),
});
const oneFactor = (v: { code?: string | undefined; recoveryCode?: string | undefined }) =>
  (v.code === undefined) !== (v.recoveryCode === undefined);
const ONE_FACTOR = { message: 'Send exactly one of code or recoveryCode' };
const VerifyBody = SecondFactorShape.extend({
  pendingToken: z.string().min(1).max(256),
}).refine(oneFactor, ONE_FACTOR);
/** The current password, re-entered for credential changes (lib/reauth). */
const CurrentPassword = z.string().min(1).max(1024);
const DisableBody = SecondFactorShape.extend({ password: CurrentPassword }).refine(
  oneFactor,
  ONE_FACTOR,
);
const ActivateBody = z.object({ code: TotpCode, password: CurrentPassword });
const EnrollBody = z.object({ password: CurrentPassword });
/** Admin actions that change who can sign in: the admin proves their own password (issue #10). */
const RegistrationChangeBody = RegistrationBody.extend({ password: CurrentPassword });
const AdminResetBody = z.object({ password: CurrentPassword });
const PendingResponse = z.object({ requires2fa: z.literal(true), pendingToken: z.string() });
const EnrollResponse = z.object({
  secret: z.string(),
  otpauthUrl: z.string(),
  qrDataUrl: z.string(),
});
const ActivateResponse = z.object({ recoveryCodes: z.array(z.string()) });
const AdminUser = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  isAdmin: z.boolean(),
  totpEnabled: z.boolean(),
  createdAt: z.number().int(),
  lastSeenAt: z.number().int().nullable(),
});
const UserIdParams = z.object({ id: z.string().min(1).max(64) });
const PendingAccount = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  lastSignInAt: z.number().int().nullable(),
});
const PepperStatus = z.object({
  currentVersion: z.number().int(),
  pending: z.array(PendingAccount),
});
const TwoFactorStatus = z.object({
  enabled: z.boolean(),
  recoveryCodesLeft: z.number().int(),
  /** False for an account created by OAuth sign-in that has not set a password yet. */
  hasPassword: z.boolean(),
});

const PublicUser = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  isAdmin: z.boolean(),
});
const UserResponse = z.object({ user: PublicUser });
const ErrorResponse = z.object({ error: z.object({ code: z.string() }) });

type PublicUserT = z.infer<typeof PublicUser>;

function toPublic(u: typeof users.$inferSelect): PublicUserT {
  return { id: u.id, email: u.email, displayName: u.displayName, isAdmin: u.isAdmin };
}

function fail(reply: FastifyReply, status: number, code: string) {
  return reply.code(status).send({ error: { code } });
}

/**
 * Starts a real session for `userId`: the HttpOnly session cookie plus the readable CSRF
 * cookie. Shared by password login, the 2FA step, registration and OAuth sign-in.
 */
export async function startUserSession(
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
): Promise<void> {
  const db = req.server.db;
  const secure = isSecureRequest(req);
  const ua = req.headers['user-agent'];
  const { token, expiresAt } = await createSession(db, userId, {
    ip: req.ip,
    ...(ua === undefined ? {} : { userAgent: ua }),
  });
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure,
    expires: new Date(expiresAt),
  });
  issueCsrfCookie(reply, secure, new Date(expiresAt));
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  const peppers = app.config.peppers ?? NO_PEPPERS;
  /** Session cookie attributes, Secure following the request's scheme (ADR-14). */
  const cookieOpts = (req: FastifyRequest) =>
    ({ httpOnly: true, sameSite: 'lax', path: '/', secure: isSecureRequest(req) }) as const;

  function readToken(req: FastifyRequest): string | undefined {
    // Literal property: the cookie name is SESSION_COOKIE.
    const raw = req.cookies.opportun_session;
    return raw === undefined || raw.length === 0 ? undefined : raw;
  }

  const startSession = startUserSession;

  const ipLimit = rateLimit({ keyFn: (req) => `ip|${req.ip}`, ...AUTH_IP_LIMIT });

  api.post(
    '/auth/register',
    {
      preHandler: ipLimit,
      schema: {
        body: RegisterBody,
        response: { 201: UserResponse, 403: ErrorResponse, 409: ErrorResponse },
      },
    },
    async (req, reply) => {
      const { email, password, displayName } = req.body;
      const passwordHash = await hashPassword(password, peppers);
      let created: typeof users.$inferSelect;
      try {
        created = await registerUser(db, { email, passwordHash, displayName });
      } catch (err) {
        if (err instanceof RegistrationClosedError) {
          return fail(reply, 403, 'registration_closed');
        }
        if (isUniqueViolation(err)) return fail(reply, 409, 'email_taken');
        throw err;
      }
      await startSession(req, reply, created.id);
      await audit(db, 'auth.register', {
        userId: created.id,
        ip: req.ip,
        detail: { isAdmin: created.isAdmin },
      });
      return reply.code(201).send({ user: toPublic(created) });
    },
  );

  // Unauthenticated on purpose, and that is not a new exposure: POST /auth/register itself is
  // unauthenticated too (only ipLimit above gates it) and already returns 403
  // registration_closed to anyone who tries, so "can I register right now" is public
  // information already. A signed-out login page needs to know whether to offer the link to
  // /register without guessing from a failed POST -- this is the read-only way to ask.
  api.get(
    '/auth/registration',
    { schema: { response: { 200: RegistrationBody } } },
    async (_req, reply) => reply.code(200).send({ open: await canRegister(db) }),
  );

  /** The email a login attempt names, already normalized by the body schema. */
  const attemptedEmail = (req: FastifyRequest): string => {
    const body = req.body as { email?: unknown } | undefined;
    return typeof body?.email === 'string' ? body.email : '';
  };

  const loginLimit = rateLimit({
    keyFn: (req) => `${req.ip}|${attemptedEmail(req)}`,
    ...LOGIN_LIMIT,
    // A throttled attempt never reaches the handler, so the limiter audits it: without this
    // a brute-force run goes quiet in the audit log exactly when it is most active. Once per
    // key per window (rateLimit coalesces), so the refusals cannot flood the log.
    onLimited: async (req) => {
      await audit(db, 'auth.login_throttled', {
        ip: req.ip,
        detail: { email: attemptedEmail(req) },
      });
    },
  });

  // The per-account backstop (EMAIL_LIMIT): keyed on the attempted email alone, so an attacker
  // rotating source IPs cannot open a fresh bucket per request. Runs after loginLimit, so a
  // single-IP attacker is stopped by the tighter per-(IP,email) bucket first and does not spend
  // this one; only attempts that clear that bucket (a distributed run) reach and drain it.
  const emailLimit = rateLimit({
    keyFn: (req) => `login-email|${attemptedEmail(req)}`,
    ...EMAIL_LIMIT,
    onLimited: async (req) => {
      await audit(db, 'auth.login_throttled', {
        ip: req.ip,
        detail: { email: attemptedEmail(req), scope: 'account' },
      });
    },
  });

  api.post(
    '/auth/login',
    {
      preHandler: [ipLimit, loginLimit, emailLimit],
      schema: {
        body: LoginBody,
        response: {
          200: z.union([UserResponse, PendingResponse]),
          401: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const { email, password } = req.body;
      const user = await db.select().from(users).where(eq(users.email, email)).get();
      // Unknown emails verify against a dummy hash so both failures cost the same.
      const { ok, rehash } = await verifyPasswordWithUpgrade(
        user?.passwordHash ?? DUMMY_HASH,
        password,
        peppers,
      );
      if (user === undefined || !ok) {
        await audit(db, 'auth.login_failed', {
          ...(user === undefined ? {} : { userId: user.id }),
          ip: req.ip,
          detail: { email },
        });
        return fail(reply, 401, 'invalid_credentials');
      }
      // The password factor passed: give back the token emailLimit spent above. That bucket
      // exists to cap wrong-password guesses against one account from a distributed attacker
      // (issue #333); a correct password is the opposite of what it is meant to catch, and
      // charging it the same way lets a client that merely retries a successful login (a flaky
      // network, a broken session-refresh loop) lock its own legitimate user out with zero wrong
      // passwords. Refunded here, before the 2FA branch below, so a password that is correct but
      // still needs a 2FA code is refunded too -- the password factor already passed either way.
      await emailLimit.refund(req);
      if (rehash) {
        // A hash from before the pepper was set: store a peppered one now that we have the
        // password. Only over the hash just verified: a password changed while this login was
        // in flight must not be put back.
        const upgraded = await hashPassword(password, peppers);
        await racePoint('auth.loginRehash');
        await db
          .update(users)
          .set({ passwordHash: upgraded, updatedAt: Date.now() })
          .where(and(eq(users.id, user.id), eq(users.passwordHash, user.passwordHash)))
          .run();
      }
      if (user.totpEnabled) {
        // The password factor passed; no session until the code step (POST /auth/2fa/verify).
        const ua = req.headers['user-agent'];
        const pendingToken = await createPendingToken(db, user.id, {
          ip: req.ip,
          ...(ua === undefined ? {} : { userAgent: ua }),
        });
        await audit(db, 'auth.2fa_challenge', { userId: user.id, ip: req.ip });
        return reply.code(200).send({ requires2fa: true, pendingToken });
      }
      await startSession(req, reply, user.id);
      await audit(db, 'auth.login', { userId: user.id, ip: req.ip });
      return reply.code(200).send({ user: toPublic(user) });
    },
  );

  // The code step shares the login budget: per IP, the same 10 per 15 minutes...
  const verifyLimit = rateLimit({ keyFn: (req) => `2fa|${req.ip}`, ...LOGIN_LIMIT });
  // ...and per USER, whatever the IP: an attacker holding the password can mint a pending
  // token from every IP they control, so the per-IP bucket alone does not cap the guesses.
  const verifyUserLimit = rateLimit({
    keyFn: async (req) => {
      const body = req.body as { pendingToken?: unknown } | undefined;
      const token = typeof body?.pendingToken === 'string' ? body.pendingToken : '';
      const owner = await pendingTokenOwner(db, token);
      return owner === null ? `2fa-user|none|${req.ip}` : `2fa-user|${owner}`;
    },
    ...LOGIN_LIMIT,
  });

  api.post(
    '/auth/2fa/verify',
    {
      preHandler: [ipLimit, verifyLimit, verifyUserLimit],
      schema: {
        body: VerifyBody,
        response: { 200: UserResponse, 401: ErrorResponse, 429: ErrorResponse },
      },
    },
    async (req, reply) => {
      const { pendingToken, code, recoveryCode } = req.body;
      const result = await redeemPendingToken(db, pendingToken, { code, recoveryCode });
      if (!result.ok) {
        if (result.code !== 'invalid_code') return fail(reply, 401, result.code);
        await audit(db, 'auth.2fa_failed', {
          userId: result.userId,
          ip: req.ip,
          detail: {
            step: 'login',
            method: code === undefined ? 'recovery' : 'totp',
            pendingRevoked: result.tokenRevoked,
          },
        });
        return fail(reply, 401, 'invalid_code');
      }
      const { userId, method } = result;
      const user = await db.select().from(users).where(eq(users.id, userId)).get();
      if (user === undefined) return fail(reply, 401, 'invalid_pending');
      await startSession(req, reply, user.id);
      await audit(db, 'auth.2fa_verified', { userId, ip: req.ip, detail: { method } });
      if (method === 'recovery') {
        await audit(db, 'auth.2fa_recovery_used', {
          userId,
          ip: req.ip,
          detail: { remaining: user.totpRecovery?.length ?? 0 },
        });
      }
      await audit(db, 'auth.login', { userId, ip: req.ip, detail: { twoFactor: true } });
      return reply.code(200).send({ user: toPublic(user) });
    },
  );

  /** A stolen session must not brute-force 2FA codes: 10 tries per 15 minutes per user. */
  const codeLimit = rateLimit({
    keyFn: (req) => `2fa-user|${req.userCtx?.userId ?? req.ip}`,
    ...LOGIN_LIMIT,
  });

  api.get(
    '/auth/2fa',
    { schema: { response: { 200: TwoFactorStatus, 401: ErrorResponse } } },
    async (req, reply) => {
      const ctx = requireUser(req);
      const user = await db
        .select({
          enabled: users.totpEnabled,
          recovery: users.totpRecovery,
          hash: users.passwordHash,
        })
        .from(users)
        .where(eq(users.id, ctx.userId))
        .get();
      if (user === undefined) return fail(reply, 401, 'unauthorized');
      return reply.code(200).send({
        enabled: user.enabled,
        recoveryCodesLeft: user.enabled ? (user.recovery?.length ?? 0) : 0,
        hasPassword: hasUsablePassword(user.hash),
      });
    },
  );

  api.post(
    '/auth/2fa/enroll',
    {
      preHandler: reauthLimits(db),
      schema: {
        body: EnrollBody,
        response: {
          200: EnrollResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          409: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const ctx = requireUser(req);
      const confirmed = await confirmPassword(req, reply, {
        userId: ctx.userId,
        password: req.body.password,
        action: '2fa.enroll',
      });
      if (!confirmed) return reply;
      const user = await db.select().from(users).where(eq(users.id, ctx.userId)).get();
      if (user === undefined) return fail(reply, 401, 'unauthorized');
      if (user.totpEnabled) return fail(reply, 409, 'already_enabled');
      // A fresh pending secret each time: enrolling again replaces an unconfirmed one. The
      // write is a compare-and-set on "not enabled": an activation that won in between keeps
      // the secret it verified.
      const secret = generateTotpSecret();
      await racePoint('twoFactor.enroll');
      const stored = await db
        .update(users)
        .set({ totpSecret: encryptSecret(db, secret), updatedAt: Date.now() })
        .where(and(eq(users.id, user.id), eq(users.totpEnabled, false)))
        .returning({ id: users.id })
        .get();
      if (stored === undefined) return fail(reply, 409, 'already_enabled');
      const url = otpauthUrl(secret, user.email);
      const qrDataUrl = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1 });
      await audit(db, 'auth.2fa_enroll_started', { userId: user.id, ip: req.ip });
      // Shown once: the secret is never returned again (re-enrolling generates a new one).
      return reply.code(200).send({ secret, otpauthUrl: url, qrDataUrl });
    },
  );

  api.post(
    '/auth/2fa/activate',
    {
      preHandler: [...reauthLimits(db), codeLimit],
      schema: {
        body: ActivateBody,
        response: {
          200: ActivateResponse,
          401: ErrorResponse,
          403: ErrorResponse,
          409: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const ctx = requireUser(req);
      const confirmed = await confirmPassword(req, reply, {
        userId: ctx.userId,
        password: req.body.password,
        action: '2fa.activate',
      });
      if (!confirmed) return reply;
      const user = await db.select().from(users).where(eq(users.id, ctx.userId)).get();
      if (user === undefined) return fail(reply, 401, 'unauthorized');
      if (user.totpEnabled) return fail(reply, 409, 'already_enabled');
      if (user.totpSecret === null) return fail(reply, 409, 'not_enrolled');
      const step = matchTotpStep(decryptSecret(db, user.totpSecret), req.body.code, Date.now());
      if (step === null) {
        await audit(db, 'auth.2fa_failed', {
          userId: user.id,
          ip: req.ip,
          detail: { step: 'activate' },
        });
        return fail(reply, 403, 'invalid_code');
      }
      const recoveryCodes = generateRecoveryCodes();
      await racePoint('twoFactor.activate');
      // Compare-and-set: enable only the secret this code was verified against, and only once.
      // A re-enroll in between (new secret) or a double submit (already on) misses: 409, and
      // no second set of recovery codes is handed out.
      const activated = await db
        .update(users)
        .set({
          totpEnabled: true,
          totpRecovery: recoveryCodes.map(hashRecoveryCode),
          totpLastStep: step,
          updatedAt: Date.now(),
        })
        .where(
          and(
            eq(users.id, user.id),
            eq(users.totpEnabled, false),
            eq(users.totpSecret, user.totpSecret),
          ),
        )
        .returning({ id: users.id })
        .get();
      if (activated === undefined) {
        const now = await db
          .select({ enabled: users.totpEnabled })
          .from(users)
          .where(eq(users.id, user.id))
          .get();
        return fail(reply, 409, now?.enabled === true ? 'already_enabled' : 'enrollment_changed');
      }
      await audit(db, 'auth.2fa_enabled', { userId: user.id, ip: req.ip });
      // Shown exactly once; only their hashes are stored.
      return reply.code(200).send({ recoveryCodes });
    },
  );

  api.post(
    '/auth/2fa/disable',
    {
      preHandler: [...reauthLimits(db), codeLimit],
      schema: {
        body: DisableBody,
        response: {
          204: z.null(),
          401: ErrorResponse,
          403: ErrorResponse,
          409: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const ctx = requireUser(req);
      // Password before the code: a wrong password spends no TOTP step or recovery code.
      const confirmed = await confirmPassword(req, reply, {
        userId: ctx.userId,
        password: req.body.password,
        action: '2fa.disable',
      });
      if (!confirmed) return reply;
      const user = await db
        .select({ enabled: users.totpEnabled, secret: users.totpSecret })
        .from(users)
        .where(eq(users.id, ctx.userId))
        .get();
      if (user === undefined) return fail(reply, 401, 'unauthorized');
      if (!user.enabled || user.secret === null) return fail(reply, 409, 'not_enabled');
      const { code, recoveryCode } = req.body;
      const method = await checkSecondFactor(db, ctx.userId, { code, recoveryCode });
      if (method === null) {
        await audit(db, 'auth.2fa_failed', {
          userId: ctx.userId,
          ip: req.ip,
          detail: { step: 'disable' },
        });
        return fail(reply, 403, 'invalid_code');
      }
      await racePoint('twoFactor.disable');
      // Clears only the 2FA this factor belonged to: one disabled and enrolled again in the
      // meantime is not this request's to remove.
      if (!(await clearTwoFactor(db, ctx.userId, user.secret))) {
        return fail(reply, 409, 'not_enabled');
      }
      await audit(db, 'auth.2fa_disabled', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { method },
      });
      return reply.code(204).send(null);
    },
  );

  api.post('/auth/logout', { schema: { response: { 204: z.null() } } }, async (req, reply) => {
    const token = readToken(req);
    if (typeof token === 'string') await destroySession(db, token);
    const ctx = req.userCtx;
    if (ctx !== null) await audit(db, 'auth.logout', { userId: ctx.userId, ip: req.ip });
    reply.clearCookie(SESSION_COOKIE, cookieOpts(req));
    clearCsrfCookie(reply, isSecureRequest(req));
    return reply.code(204).send(null);
  });

  api.get(
    '/auth/me',
    { schema: { response: { 200: UserResponse, 401: ErrorResponse } } },
    async (req, reply) => {
      const ctx = requireUser(req);
      const user = await db.select().from(users).where(eq(users.id, ctx.userId)).get();
      if (user === undefined) return fail(reply, 401, 'unauthorized');
      return reply.code(200).send({ user: toPublic(user) });
    },
  );

  /** Password changes share the login budget, per user: 10 per 15 minutes. */
  const passwordLimit = rateLimit({
    keyFn: (req) => `password|${req.userCtx?.userId ?? req.ip}`,
    ...LOGIN_LIMIT,
  });

  api.post(
    '/auth/password',
    {
      preHandler: [ipLimit, passwordLimit],
      schema: {
        body: PasswordBody,
        response: { 204: z.null(), 401: ErrorResponse, 403: ErrorResponse, 429: ErrorResponse },
      },
    },
    async (req, reply) => {
      const ctx = requireUser(req);
      const user = await db.select().from(users).where(eq(users.id, ctx.userId)).get();
      if (user === undefined) return fail(reply, 401, 'unauthorized');
      // An OAuth-created account has no password to prove: its session sets the first one.
      // Every other account proves the current password, as before.
      const initial = req.body.current === undefined;
      if (initial) {
        if (hasUsablePassword(user.passwordHash)) {
          return fail(reply, 403, 'invalid_current_password');
        }
        // M-1: the session alone is not enough to mint a permanent credential; it needs a
        // fresh round trip through a linked provider (POST /auth/oauth/:provider/setpw).
        const token = readToken(req);
        if (token === undefined || !consumePasswordSetGrant(db, sessionIdOf(token), user.id)) {
          return fail(reply, 403, 'reauth_required');
        }
      } else {
        const current = await verifyPasswordWithUpgrade(
          user.passwordHash,
          req.body.current ?? '',
          peppers,
        );
        if (!current.ok) return fail(reply, 403, 'invalid_current_password');
      }
      const passwordHash = await hashPassword(req.body.next, peppers);
      await racePoint('auth.passwordChange');
      // Compare-and-set on the hash `current` was proven against: a concurrent change (or an
      // admin reset after a compromise) in between makes this one stale, not the winner.
      const changed = await db
        .update(users)
        .set({ passwordHash, updatedAt: Date.now() })
        .where(and(eq(users.id, user.id), eq(users.passwordHash, user.passwordHash)))
        .returning({ id: users.id })
        .get();
      if (changed === undefined) return fail(reply, 403, 'invalid_current_password');
      // Every existing session (other devices and this one) dies; this client gets a fresh token.
      await destroyAllSessions(db, user.id);
      await startSession(req, reply, user.id);
      await audit(db, initial ? 'auth.password_set_initial' : 'auth.password_changed', {
        userId: user.id,
        ip: req.ip,
      });
      return reply.code(204).send(null);
    },
  );

  api.patch(
    '/admin/registration',
    {
      // Reopening registration lets an attacker mint a durable account that outlives a
      // rotated admin password, so a stolen session cookie alone must not be enough (issue
      // #10, the same line lib/reauth.ts draws for 2FA and device tokens).
      preHandler: reauthLimits(db),
      schema: {
        body: RegistrationChangeBody,
        response: {
          200: RegistrationBody,
          401: ErrorResponse,
          403: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const ctx = requireUser(req);
      if (!ctx.isAdmin) return fail(reply, 403, 'forbidden');
      const confirmed = await confirmPassword(req, reply, {
        userId: ctx.userId,
        password: req.body.password,
        action: 'admin.registration',
      });
      if (!confirmed) return reply;
      const { open } = req.body;
      const now = Date.now();
      await db
        .insert(settings)
        .values({ key: REGISTRATION_OPEN_KEY, userId: null, value: open, updatedAt: now })
        .onConflictDoUpdate({ target: settings.key, set: { value: open, updatedAt: now } })
        .run();
      return reply.code(200).send({ open });
    },
  );
  api.get(
    '/admin/registration',
    { schema: { response: { 200: RegistrationBody, 401: ErrorResponse, 403: ErrorResponse } } },
    async (req, reply) => {
      const ctx = requireUser(req);
      if (!ctx.isAdmin) return fail(reply, 403, 'forbidden');
      return reply.code(200).send({ open: await isRegistrationOpen(db) });
    },
  );

  api.get(
    '/admin/users',
    {
      schema: {
        response: {
          200: z.object({ items: z.array(AdminUser) }),
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const ctx = requireUser(req);
      if (!ctx.isAdmin) return fail(reply, 403, 'forbidden');
      // Instance-level by design: the admin sees every account, never any credential column.
      // lastSeenAt (issue #281, persisted per #320): users.last_seen_at itself, written by
      // createSession (sign-in) and getSessionUser's throttled touch (lib/sessions.ts) -- not
      // derived from live session rows here, since a derived max(sessions.last_seen_at) cannot
      // answer a question about history once destroySession deletes the row on sign-out.
      const items = await db
        .select({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          isAdmin: users.isAdmin,
          totpEnabled: users.totpEnabled,
          createdAt: users.createdAt,
          lastSeenAt: users.lastSeenAt,
        })
        .from(users)
        .orderBy(asc(users.createdAt), asc(users.id))
        .all();
      return reply.code(200).send({ items });
    },
  );

  api.get(
    '/admin/peppers',
    { schema: { response: { 200: PepperStatus, 401: ErrorResponse, 403: ErrorResponse } } },
    async (req, reply) => {
      const ctx = requireUser(req);
      if (!ctx.isAdmin) return fail(reply, 403, 'forbidden');
      if (peppers.current === 0) return reply.code(200).send({ currentVersion: 0, pending: [] });
      // Accounts whose stored hash predates the current pepper version, so an operator can tell
      // when install.md's rotation step 4 ("drop the previous secret") is actually safe. OAuth-only
      // accounts have no password to rehash and are never pending.
      const rows = await db
        .select({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          passwordHash: users.passwordHash,
        })
        .from(users)
        .orderBy(asc(users.createdAt), asc(users.id))
        .all();
      const notYetCurrent = rows.filter(
        (u) => hasUsablePassword(u.passwordHash) && hashVersion(u.passwordHash) !== peppers.current,
      );
      // Last sign-in per pending account, so an operator can tell "still blocking, but about
      // to resolve itself" from "has not signed in for months and probably never will".
      const lastSignIns =
        notYetCurrent.length === 0
          ? []
          : await db
              .select({ userId: auditLog.userId, lastSignInAt: max(auditLog.createdAt) })
              .from(auditLog)
              .where(
                and(
                  eq(auditLog.event, 'auth.login'),
                  inArray(
                    auditLog.userId,
                    notYetCurrent.map((u) => u.id),
                  ),
                ),
              )
              .groupBy(auditLog.userId)
              .all();
      const lastSignInById = new Map(lastSignIns.map((r) => [r.userId, r.lastSignInAt]));
      const pending = notYetCurrent.map(({ id, email, displayName }) => ({
        id,
        email,
        displayName,
        lastSignInAt: lastSignInById.get(id) ?? null,
      }));
      return reply.code(200).send({ currentVersion: peppers.current, pending });
    },
  );

  api.post(
    '/admin/users/:id/reset-password',
    {
      // The most account-takeover-shaped action in the API: it must cost more than a cookie
      // (issue #10), so the admin re-enters their own password, rate limited with the other
      // re-authentication routes. An admin with no usable password (an OAuth-only account)
      // sets one first, exactly as for 2FA and device tokens.
      preHandler: reauthLimits(db),
      schema: {
        params: UserIdParams,
        body: AdminResetBody,
        response: {
          200: z.object({ temporaryPassword: z.string() }),
          401: ErrorResponse,
          403: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const ctx = requireUser(req);
      if (!ctx.isAdmin) return fail(reply, 403, 'forbidden');
      const targetId = req.params.id;
      // An admin changes their own password with the current one; a stolen admin session must
      // not be able to lock the real admin out by resetting it.
      if (targetId === ctx.userId) return fail(reply, 409, 'self_reset');
      // Before the target lookup, so a wrong password learns nothing about which ids exist.
      const confirmed = await confirmPassword(req, reply, {
        userId: ctx.userId,
        password: req.body.password,
        action: 'admin.reset_password',
      });
      if (!confirmed) return reply;
      const target = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, targetId))
        .get();
      if (target === undefined) return fail(reply, 404, 'not_found');
      const temporaryPassword = await resetUserPassword(db, target.id, peppers);
      await audit(db, 'admin.password_reset', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { targetUserId: target.id },
      });
      // Shown once to the admin, who hands it over out of band; never stored or logged.
      return reply.code(200).send({ temporaryPassword });
    },
  );
}
