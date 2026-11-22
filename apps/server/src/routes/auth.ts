// Local auth (FR-S1, FR-S2, FR-S3, NFR-SEC3): registration lock, login (two-step when TOTP 2FA
// is on), 2FA enrollment, logout, me, password change, and the admin surface: registration
// toggle, users list and password reset.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, asc, eq, inArray, max } from 'drizzle-orm';
import QRCode from 'qrcode';
import { z } from 'zod';
import { isUniqueViolation, lockScope, withTransaction } from '../db/client';
import { auditLog, settings, users } from '../db/schema';
import { audit } from '../lib/audit';
import { SHARED_DEMO_IDS } from '../lib/demoAccounts';
import { isSharedDemoAdmin } from '../lib/demoSharedAdmin';
import { racePoint } from '../lib/racePoints';
import { revokeAllDeviceTokens } from '../lib/deviceTokens';
import { resetPasswordIn, temporaryPassword as temporaryResetPassword } from '../lib/passwordReset';
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
  passwordScope,
  verifyPasswordWithUpgrade,
} from '../lib/passwords';
import { whilePasswordCurrent, withPasswordLock } from '../lib/passwordLock';
import { rateLimit } from '../lib/rateLimit';
import { confirmedPasswordHash, confirmPassword, reauthLimits } from '../lib/reauth';
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
  pendingTokenStored,
  takeRevokedPending,
  redeemPendingToken,
} from '../lib/twoFactor';
import { clearCsrfCookie, isSecureRequest, issueCsrfCookie } from '../plugins/security';
import { requireUser, type UserCtx } from '../repos/base';

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
  /**
   * Also revoke every device token of the user (the browser extension, the Mail connector), as
   * the admin and CLI reset always does (#523, sec's audit). The dialog offers it, checked by
   * default; omitted means no, so another client's change keeps today's behaviour.
   */
  revokeDeviceTokens: z.boolean().optional(),
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

/**
 * The password just proven was changed or reset before the write that needed it (#620): 403
 * password_changed, as a device token's creation answers the same race (lib/deviceTokens.ts), not
 * invalid_password, since the password typed was right. Audited as a failed re-auth, with the
 * reason (and, for an admin's reset, the account it was for).
 */
async function passwordChanged(
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  action: string,
  extra: Record<string, string> = {},
) {
  await audit(req.server.db, 'auth.reauth_failed', {
    userId,
    ip: req.ip,
    detail: { action, reason: 'password_changed', ...extra },
  });
  return reply.code(403).send({
    error: {
      code: 'password_changed',
      message:
        'Your password changed while this was being checked. Sign in again and try once more.',
    },
  });
}

function fail(reply: FastifyReply, status: number, code: string) {
  return reply.code(status).send({ error: { code } });
}

/** What a new session or pending 2FA token records of the request that made it. */
export function sessionMeta(req: FastifyRequest): { ip: string; userAgent?: string } {
  const ua = req.headers['user-agent'];
  return { ip: req.ip, ...(ua === undefined ? {} : { userAgent: ua }) };
}

/**
 * The cookies for a session already written (createSession), set only once the transaction that
 * wrote it, and its audit row, has committed (#779): a failed write then sets no cookie.
 */
export function setSessionCookies(
  req: FastifyRequest,
  reply: FastifyReply,
  { token, expiresAt }: { token: string; expiresAt: number },
): void {
  const secure = isSecureRequest(req);
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
  /** The users an admin list shows: every one, or the pinned ones for the shared demo admin. */
  const sharedOnly = (ctx: UserCtx) =>
    isSharedDemoAdmin(app.config, ctx) ? inArray(users.id, [...SHARED_DEMO_IDS]) : undefined;
  const peppers = app.config.peppers ?? NO_PEPPERS;
  /** Session cookie attributes, Secure following the request's scheme (ADR-14). */
  const cookieOpts = (req: FastifyRequest) =>
    ({ httpOnly: true, sameSite: 'lax', path: '/', secure: isSecureRequest(req) }) as const;

  function readToken(req: FastifyRequest): string | undefined {
    // Literal property: the cookie name is SESSION_COOKIE.
    const raw = req.cookies.opportun_session;
    return raw === undefined || raw.length === 0 ? undefined : raw;
  }

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
      let session: Awaited<ReturnType<typeof createSession>> | undefined;
      let created: typeof users.$inferSelect;
      try {
        // The account, its first session and the audit row commit together (#779): a failed
        // audit write leaves no account behind, so the same registration can be tried again.
        created = await registerUser(db, { email, passwordHash, displayName }, async (tx, row) => {
          session = await createSession(tx, row.id, sessionMeta(req));
          await audit(tx, 'auth.register', {
            userId: row.id,
            ip: req.ip,
            detail: { isAdmin: row.isAdmin },
          });
        });
      } catch (err) {
        if (err instanceof RegistrationClosedError) {
          return fail(reply, 403, 'registration_closed');
        }
        if (isUniqueViolation(err)) return fail(reply, 409, 'email_taken');
        throw err;
      }
      // Written with the account, in its transaction: set once that has committed.
      if (session === undefined) throw new Error('registration committed without its session');
      setSessionCookies(req, reply, session);
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
      // The password is proven; a change or reset can commit from here on (#561).
      await racePoint('auth.login.passwordChecked');
      // A hash from before the pepper was set gets a peppered one now that we have the password.
      const upgraded = rehash ? await hashPassword(password, peppers) : undefined;
      if (upgraded !== undefined) await racePoint('auth.loginRehash');
      // The session, or the pending 2FA token, is written only while the hash just verified is
      // still the user's, under the lock a change and a reset take (#561): one that committed
      // since the check wins, and this login is refused as a wrong password would be. The
      // rehash is the check itself, so it never puts back a password changed meanwhile. Accepted
      // (tl on #571): two logins at once on an unpeppered hash, the first rehashes it and the
      // second is refused like a wrong password. That can happen only on the first sign-in after
      // a pepper is set, and the second login succeeds when tried again.
      const written = await whilePasswordCurrent(
        db,
        user.id,
        user.passwordHash,
        // Whether 2FA is on is read here, under the lock, not with the password above (#620): an
        // activation that committed during the check gives a pending token, never a full session.
        // The audit row is written with the session or pending token (#779): a failed write rolls
        // both back, and no cookie or token is handed out.
        async (tx) => {
          const twoFactor =
            (
              await tx
                .select({ totpEnabled: users.totpEnabled })
                .from(users)
                .where(eq(users.id, user.id))
                .get()
            )?.totpEnabled === true;
          if (twoFactor) {
            const pendingToken = await createPendingToken(tx, user.id, sessionMeta(req));
            await audit(tx, 'auth.2fa_challenge', { userId: user.id, ip: req.ip });
            return { kind: 'pending' as const, pendingToken };
          }
          const session = await createSession(tx, user.id, sessionMeta(req));
          await audit(tx, 'auth.login', { userId: user.id, ip: req.ip });
          return { kind: 'session' as const, session };
        },
        { ...(upgraded === undefined ? {} : { rehashTo: upgraded }), point: 'auth.login.locked' },
      );
      if (!written.current) {
        // The wrong-password path: the same answer, the same budget (emailLimit keeps the token
        // it spent), and the same audit event, with the reason.
        await audit(db, 'auth.login_failed', {
          userId: user.id,
          ip: req.ip,
          detail: { email, reason: 'password_changed' },
        });
        return fail(reply, 401, 'invalid_credentials');
      }
      // The password factor passed: give back the token emailLimit spent above. That bucket
      // exists to cap wrong-password guesses against one account from a distributed attacker
      // (issue #333); a correct password is the opposite of what it is meant to catch, and
      // charging it the same way lets a client that merely retries a successful login (a flaky
      // network, a broken session-refresh loop) lock its own legitimate user out with zero wrong
      // passwords. Refunded for a password that is correct but still needs a 2FA code too: the
      // password factor already passed either way.
      await emailLimit.refund(req);
      if (written.value.kind === 'pending') {
        // The password factor passed; no session until the code step (POST /auth/2fa/verify).
        return reply
          .code(200)
          .send({ requires2fa: true, pendingToken: written.value.pendingToken });
      }
      setSessionCookies(req, reply, written.value.session);
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
      // The code is proven; a change or reset can commit from here on (#561).
      await racePoint('auth.2faVerify.redeemed');
      const user = await db.select().from(users).where(eq(users.id, userId)).get();
      if (user === undefined) return fail(reply, 401, 'invalid_pending');
      // The session is written only while the pending token is still stored, under the password
      // lock: a change or reset deletes every one of the user's under the same lock (#561).
      // Its audit rows are written with it (#779): a failed write leaves no session and sets no
      // cookie. The code redeemed above stays spent: that claim commits on its own, before the
      // lock (#561), and the user starts again from the password step.
      const session = await withPasswordLock(db, userId, async (tx) => {
        if (!(await pendingTokenStored(tx, pendingToken))) return null;
        const written = await createSession(tx, userId, sessionMeta(req));
        await audit(tx, 'auth.2fa_verified', { userId, ip: req.ip, detail: { method } });
        if (method === 'recovery') {
          await audit(tx, 'auth.2fa_recovery_used', {
            userId,
            ip: req.ip,
            detail: { remaining: user.totpRecovery?.length ?? 0 },
          });
        }
        await audit(tx, 'auth.login', { userId, ip: req.ip, detail: { twoFactor: true } });
        return written;
      });
      if (session === null) {
        // A change or reset since the claim (#662): say so, rather than that it took too long.
        const changed = await takeRevokedPending(db, pendingToken);
        return fail(reply, 401, changed ? 'password_changed' : 'invalid_pending');
      }
      setSessionCookies(req, reply, session);
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
      const verified = await confirmedPasswordHash(req, reply, {
        userId: ctx.userId,
        password: req.body.password,
        action: '2fa.enroll',
      });
      if (verified === null) return reply;
      const user = await db.select().from(users).where(eq(users.id, ctx.userId)).get();
      if (user === undefined) return fail(reply, 401, 'unauthorized');
      if (user.totpEnabled) return fail(reply, 409, 'already_enabled');
      // A fresh pending secret each time: enrolling again replaces an unconfirmed one. The
      // write is a compare-and-set on "not enabled": an activation that won in between keeps
      // the secret it verified.
      const secret = generateTotpSecret();
      await racePoint('twoFactor.enroll');
      // Only while the password just proven is still the user's (#620): a change or reset that
      // committed since the check wins, as for a sign-in (#561).
      // The secret and its audit row commit together (#779).
      const written = await whilePasswordCurrent(db, user.id, verified, async (tx) => {
        const row = await tx
          .update(users)
          .set({ totpSecret: encryptSecret(db, secret), updatedAt: Date.now() })
          .where(and(eq(users.id, user.id), eq(users.totpEnabled, false)))
          .returning({ id: users.id })
          .get();
        if (row !== undefined) {
          await audit(tx, 'auth.2fa_enroll_started', { userId: user.id, ip: req.ip });
        }
        return row;
      });
      if (!written.current) return passwordChanged(req, reply, user.id, '2fa.enroll');
      if (written.value === undefined) return fail(reply, 409, 'already_enabled');
      const url = otpauthUrl(secret, user.email);
      const qrDataUrl = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1 });
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
      const verified = await confirmedPasswordHash(req, reply, {
        userId: ctx.userId,
        password: req.body.password,
        action: '2fa.activate',
      });
      if (verified === null) return reply;
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
      // And only while the password just proven is still the user's (#620).
      // And its audit row commits with it (#779).
      const written = await whilePasswordCurrent(db, user.id, verified, async (tx) => {
        const row = await tx
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
              eq(users.totpSecret, user.totpSecret as string),
            ),
          )
          .returning({ id: users.id })
          .get();
        if (row !== undefined) await audit(tx, 'auth.2fa_enabled', { userId: user.id, ip: req.ip });
        return row;
      });
      if (!written.current) return passwordChanged(req, reply, user.id, '2fa.activate');
      const activated = written.value;
      if (activated === undefined) {
        const now = await db
          .select({ enabled: users.totpEnabled })
          .from(users)
          .where(eq(users.id, user.id))
          .get();
        return fail(reply, 409, now?.enabled === true ? 'already_enabled' : 'enrollment_changed');
      }
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
      // The removal and its audit row commit together (#779).
      const cleared = await withTransaction(db, async (tx) => {
        if (!(await clearTwoFactor(tx, ctx.userId, user.secret as string))) return false;
        await audit(tx, 'auth.2fa_disabled', {
          userId: ctx.userId,
          ip: req.ip,
          detail: { method },
        });
        return true;
      });
      if (!cleared) return fail(reply, 409, 'not_enabled');
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
      // The revocation, when asked (#523), commits with the new hash or not at all: a refused
      // change revokes nothing, and a crash cannot leave the password changed and tokens live.
      const changed = await withTransaction(db, async (tx) => {
        // The lock a token minted after a password check takes (#539): such a mint waits for
        // this change, then finds the hash it verified gone and creates nothing.
        await lockScope(tx, passwordScope(user.id));
        const row = await tx
          .update(users)
          .set({ passwordHash, updatedAt: Date.now() })
          .where(and(eq(users.id, user.id), eq(users.passwordHash, user.passwordHash)))
          .returning({ id: users.id })
          .get();
        if (row === undefined) return undefined;
        const revoked =
          req.body.revokeDeviceTokens === true ? await revokeAllDeviceTokens(tx, user.id) : 0;
        // Every session and pending 2FA token, under the lock (#561): a sign-in that proved the
        // old password and holds the lock wrote before this, and is deleted here with the rest.
        await destroyAllSessions(tx, user.id);
        // This client's fresh session, in the same transaction (tl on #571): written after the
        // commit, a reset that waited on the lock could run first and leave it standing.
        const session = await createSession(tx, user.id, sessionMeta(req));
        // And the audit row, so a failed write rolls the change back with it (#779).
        await audit(tx, initial ? 'auth.password_set_initial' : 'auth.password_changed', {
          userId: user.id,
          ip: req.ip,
          // A count, under a key the audit's redaction leaves alone (it hides any key with "token").
          ...(req.body.revokeDeviceTokens === true ? { detail: { revokedDevices: revoked } } : {}),
        });
        await racePoint('auth.passwordChange.locked');
        return { revoked, session };
      });
      if (changed === undefined) return fail(reply, 403, 'invalid_current_password');
      // The change has committed; a reset can run from here on (tl on #571).
      await racePoint('auth.passwordChange.committed');
      // Every existing session (other devices and this one) died with the change; this client
      // gets the fresh one written with it.
      setSessionCookies(req, reply, changed.session);
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
        // The shared demo admin sees the pinned accounts only (#563): a dedicated account's email
        // and name are not every invitee's to read.
        .where(sharedOnly(ctx))
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
        .where(sharedOnly(ctx))
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
          200: z.object({
            temporaryPassword: z.string(),
            /** The providers the reset unlinked (#573), for the admin to have linked again. */
            unlinkedProviders: z.array(z.string()),
          }),
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
      const verified = await confirmedPasswordHash(req, reply, {
        userId: ctx.userId,
        password: req.body.password,
        action: 'admin.reset_password',
      });
      if (verified === null) return reply;
      await racePoint('admin.resetPassword.checked');
      // The shared demo admin resets pinned accounts only (#563), and is told so before any
      // lookup: a dedicated account's id is not confirmed or denied.
      if (isSharedDemoAdmin(app.config, ctx) && !SHARED_DEMO_IDS.has(targetId)) {
        return fail(reply, 403, 'forbidden');
      }
      const target = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, targetId))
        .get();
      if (target === undefined) return fail(reply, 404, 'not_found');
      const temporaryPassword = temporaryResetPassword();
      const newHash = await hashPassword(temporaryPassword, peppers);
      // The reset, only while the admin's own password just proven is still theirs (#620): one
      // transaction holding both accounts' password locks, taken in one order (sorted), so two
      // admins resetting each other cannot each hold one and wait on the other.
      const unlinkedProviders = await withTransaction(db, async (tx) => {
        for (const scope of [passwordScope(ctx.userId), passwordScope(target.id)].sort()) {
          await lockScope(tx, scope);
        }
        const still = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.id, ctx.userId), eq(users.passwordHash, verified)))
          .get();
        if (still === undefined) return 'password_changed' as const;
        // The account is looked up again under the lock: one deleted since gets no password.
        const exists = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, target.id))
          .get();
        if (exists === undefined) return 'not_found' as const;
        // Inside the lock, after the re-check (the race tests park here).
        await racePoint('admin.resetPassword.locked');
        const unlinked = await resetPasswordIn(tx, target.id, newHash);
        // The audit row in the reset's transaction, as its last write (#661): a failed write
        // rolls the reset back, so the target is never left reset with a password the admin was
        // never sent. Not on the password_changed or not_found returns above: nothing was reset.
        await audit(tx, 'admin.password_reset', {
          userId: ctx.userId,
          ip: req.ip,
          detail: {
            targetUserId: target.id,
            ...(unlinked.length === 0 ? {} : { unlinkedProviders: unlinked }),
          },
        });
        return unlinked;
      });
      if (unlinkedProviders === 'password_changed') {
        return passwordChanged(req, reply, ctx.userId, 'admin.reset_password', {
          targetUserId: target.id,
        });
      }
      if (unlinkedProviders === 'not_found') return fail(reply, 404, 'not_found');
      // Shown once to the admin, who hands it over out of band; never stored or logged.
      return reply.code(200).send({ temporaryPassword, unlinkedProviders });
    },
  );
}
