// OAuth sign-in (FR-S4): the admin's provider credentials, the public provider list, and the
// login/link/unlink flows. (Sign-in with Google here is unrelated to the Google Drive/Gmail
// integration in routes/googleAuth.ts: separate client, callback and state key.)
//
// Account rules (plan Task 6, Review Focus 2, coordinator ruling R2):
//   - Linking is the ONLY way a provider account joins an existing one: a signed-in POST
//     with the current password (the Wave-1 re-auth convention), and the callback must come
//     back to that same live session (the state is bound to it). A provider account already
//     linked to someone else is refused (flash oauth=conflict).
//   - Login: a linked provider account signs in. A provider email matching an existing
//     account NEVER links or signs in, verified or not: there is no email-based password
//     reset here, so control of a mailbox must not become access to an account. A verified
//     match gets flash oauth=existing_account (sign in with the password, then link); an
//     unverified one gets oauth=unknown (it proves nothing, so it reveals nothing). With
//     registration open, a verified email that matches no account creates one with an
//     unusable password; anything else is oauth=unknown.
//   - A 2FA-enabled account still gets the pending-2fa step: OAuth replaces only the password.
import { newId } from '@opportun/core';
import { and, count, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withTransaction, isUniqueViolation } from '../db/client';
import { oauthAccounts, users } from '../db/schema';
import { audit } from '../lib/audit';
import { readClientCreds, readClientId } from '../lib/google';
import { racePoint } from '../lib/racePoints';
import { HttpError } from '../lib/errors';
import {
  deleteProviderCreds,
  exchangeAndIdentify,
  buildAuthorizeUrl,
  OAUTH_PROVIDERS,
  providerAvailable,
  providerConfigured,
  providerUsesPkce,
  readProviderClientId,
  readProviderCreds,
  redirectUriFor,
  writeProviderCreds,
  type OAuthIdentity,
  type OAuthProvider,
} from '../lib/oauthProviders';
import {
  grantPasswordSet,
  newBinding,
  OAUTH_STATE_TTL_MS,
  pkceVerifier,
  sessionIdOf,
  signOAuthState,
  spendNonce,
  verifyOAuthState,
  type OAuthMode,
} from '../lib/oauthState';
import { hasUsablePassword, unusablePasswordHash } from '../lib/passwords';
import { rateLimit } from '../lib/rateLimit';
import { confirmPassword, reauthLimits } from '../lib/reauth';
import { createPendingToken } from '../lib/twoFactor';
import { isRegistrationOpen } from '../lib/registration';
import { isSecureRequest } from '../plugins/security';
import { requireUser, type UserCtx } from '../repos/base';
import { startUserSession } from './auth';

/** HttpOnly cookie holding the browser binding of an in-flight OAuth flow. */
/**
 * The binding cookie. On a request that arrived over https it carries the __Host- prefix
 * (Secure, path=/, no Domain), so a sibling subdomain cannot toss in a cookie of its own
 * under that name. A plain-http request (local or LAN) cannot hold a Secure cookie, so it
 * falls back to the unprefixed name, still HttpOnly, SameSite=Lax and host-only.
 */
export const OAUTH_BINDING_COOKIE_SECURE = '__Host-opportun_oauth';
export const OAUTH_BINDING_COOKIE_DEV = 'opportun_oauth';
const LOGIN_PAGE = '/login';
const SECURITY_PAGE = '/settings/security';
/** Starts and callbacks per IP: generous for people, tight for a script. */
const OAUTH_IP_LIMIT = { limit: 30, windowMs: 15 * 60 * 1000 };

const ProviderParams = z.object({ provider: z.enum(OAUTH_PROVIDERS) });
const CredsBody = z.object({
  clientId: z.string().trim().min(1).max(300),
  clientSecret: z.string().trim().min(1).max(500),
});
/** GET start is login only: linking goes through the password-confirmed POST .../link. */
const StartQuery = z.object({ mode: z.literal('login') });
const LinkBody = z.object({ password: z.string().min(1).max(1024) });
const CallbackQuery = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(1024).optional(),
  error: z.string().max(200).optional(),
});
const UnlinkBody = z.object({ password: z.string().min(1).max(1024).optional() });
const LinkedAccounts = z.object({
  /** False for an account created by OAuth sign-in (no password to confirm or fall back to). */
  hasPassword: z.boolean(),
  accounts: z.array(z.object({ provider: z.enum(OAUTH_PROVIDERS), createdAt: z.number().int() })),
});

type LoginOutcome =
  | { ok: true; userId: string; how: 'linked' | 'created' }
  | {
      ok: false;
      reason: 'unverified_email' | 'no_email' | 'existing_account' | 'registration_closed';
      userId?: string;
    };

const ProviderStatus = z.object({
  provider: z.enum(OAUTH_PROVIDERS),
  configured: z.boolean(),
  /**
   * False when this instance cannot use the provider at all. Every provider is available
   * today (LinkedIn through the C-1 official-API carve-out in safeFetch.ts); the flag stays so
   * the admin screen can show a provider that a future build has to switch off.
   */
  available: z.boolean(),
  /** The exact redirect URI to register with the provider (from BASE_URL). */
  redirectUri: z.string(),
  /**
   * The client id this admin already saved for the Google Drive/Gmail integration, which the
   * same Google client can serve (one client holds several redirect URIs, and scopes are asked
   * for per flow). Null for the other providers, which have no second place to look, and when
   * nothing is on file. An id is not a secret; the secret is copied server side by .../import.
   */
  integrationClientId: z.string().nullable(),
  /**
   * True when the sign-in client and that integration client are one and the same, so the card
   * can say that rotating or revoking it in either place breaks the other. The stored sign-in
   * client id is never echoed; a caller learns only whether the two match.
   */
  sharesIntegrationClient: z.boolean(),
});

export async function oauthLoginRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  const baseUrl = app.config.baseUrl;

  const status = async (
    provider: OAuthProvider,
    ctx: UserCtx,
  ): Promise<z.infer<typeof ProviderStatus>> => {
    const integrationClientId =
      provider === 'google' ? ((await readClientId(db, ctx)) ?? null) : null;
    const clientId = await readProviderClientId(db, provider);
    return {
      provider,
      configured: clientId !== undefined,
      available: providerAvailable(provider),
      redirectUri: redirectUriFor(baseUrl, provider),
      integrationClientId,
      sharesIntegrationClient: clientId !== undefined && clientId === integrationClientId,
    };
  };

  function requireAdmin(req: Parameters<typeof requireUser>[0]) {
    const ctx = requireUser(req);
    if (!ctx.isAdmin) throw new HttpError(403, 'forbidden');
    return ctx;
  }

  api.get(
    '/admin/oauth-providers',
    { schema: { response: { 200: z.object({ items: z.array(ProviderStatus) }) } } },
    async (req) => {
      const ctx = requireAdmin(req);
      const items = [];
      for (const provider of OAUTH_PROVIDERS) items.push(await status(provider, ctx));
      return { items };
    },
  );

  api.get(
    '/admin/oauth-providers/:provider',
    { schema: { params: ProviderParams, response: { 200: ProviderStatus } } },
    async (req) => {
      const ctx = requireAdmin(req);
      return await status(req.params.provider, ctx);
    },
  );

  api.put(
    '/admin/oauth-providers/:provider',
    { schema: { params: ProviderParams, body: CredsBody, response: { 200: ProviderStatus } } },
    async (req) => {
      const ctx = requireAdmin(req);
      const { provider } = req.params;
      if (!providerAvailable(provider)) throw new HttpError(409, 'provider_unavailable');
      await writeProviderCreds(db, provider, req.body);
      await audit(db, 'admin.oauth_provider_configured', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { provider },
      });
      return await status(provider, ctx);
    },
  );

  /**
   * Reuse the Google client already saved for the Drive/Gmail integration rather than making
   * the admin fetch the same two values from the console again. The secret is read and written
   * inside the server: it is never sent to the browser, in either direction. The two stores
   * stay independent afterwards, so removing one cannot disturb the other, and the client must
   * still carry THIS redirect URI (the UI says so) or Google answers redirect_uri_mismatch.
   */
  api.post(
    '/admin/oauth-providers/:provider/import',
    { schema: { params: ProviderParams, response: { 200: ProviderStatus } } },
    async (req) => {
      const ctx = requireAdmin(req);
      const { provider } = req.params;
      if (provider !== 'google') throw new HttpError(409, 'import_unsupported');
      // The integration client belongs to the admin asking, never to another user (FR-S5).
      const creds = await readClientCreds(db, ctx);
      if (creds === undefined) throw new HttpError(409, 'integration_client_missing');
      await writeProviderCreds(db, provider, creds);
      await audit(db, 'admin.oauth_provider_configured', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { provider, source: 'google_integration' },
      });
      return await status(provider, ctx);
    },
  );

  api.delete(
    '/admin/oauth-providers/:provider',
    { schema: { params: ProviderParams, response: { 204: z.null() } } },
    async (req, reply) => {
      const ctx = requireAdmin(req);
      const { provider } = req.params;
      await deleteProviderCreds(db, provider);
      await audit(db, 'admin.oauth_provider_removed', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { provider },
      });
      return reply.code(204).send(null);
    },
  );

  const ipLimit = rateLimit({ keyFn: (req) => `oauth|${req.ip}`, ...OAUTH_IP_LIMIT });
  /**
   * The binding cookie follows the request's scheme, not OPPORTUN_BASE_URL (ADR-14). Both
   * legs of a flow are on one origin anyway: the callback returns to the redirect URI and
   * the cookie is host-only, so a flow started anywhere else could never finish.
   */
  const bindingCookie = (req: FastifyRequest) =>
    ({ httpOnly: true, sameSite: 'lax', path: '/', secure: isSecureRequest(req) }) as const;
  const bindingCookieName = (req: FastifyRequest) =>
    isSecureRequest(req) ? OAUTH_BINDING_COOKIE_SECURE : OAUTH_BINDING_COOKIE_DEV;
  /** Only the name this request's scheme sets is ever read (never the other one). */
  const readBinding = (req: FastifyRequest): string =>
    (isSecureRequest(req) ? req.cookies['__Host-opportun_oauth'] : req.cookies.opportun_oauth) ??
    '';

  function sessionIdFrom(req: FastifyRequest): string | null {
    // Literal property: the cookie name is SESSION_COOKIE (routes/auth.ts).
    const token = req.cookies.opportun_session;
    return token === undefined || token.length === 0 || req.userCtx === null
      ? null
      : sessionIdOf(token);
  }

  /** Signs a state for this flow, sets the binding cookie, and returns the provider URL. */
  async function authorize(
    req: FastifyRequest,
    reply: FastifyReply,
    provider: OAuthProvider,
    mode: OAuthMode,
    sessionId: string,
  ): Promise<string> {
    if (!providerAvailable(provider)) throw new HttpError(409, 'provider_unavailable');
    const creds = await readProviderCreds(db, provider);
    if (creds === undefined) throw new HttpError(409, 'provider_not_configured');
    const binding = newBinding();
    const { state, nonce } = signOAuthState(app.config.masterKey, {
      provider,
      mode,
      binding,
      sessionId,
    });
    reply.setCookie(bindingCookieName(req), binding, {
      ...bindingCookie(req),
      maxAge: OAUTH_STATE_TTL_MS / 1000,
    });
    return buildAuthorizeUrl(provider, {
      clientId: creds.clientId,
      redirectUri: redirectUriFor(baseUrl, provider),
      state,
      ...(providerUsesPkce(provider)
        ? { codeVerifier: pkceVerifier(app.config.masterKey, binding, nonce) }
        : {}),
    });
  }

  api.get(
    '/auth/oauth/:provider/start',
    { preHandler: ipLimit, schema: { params: ProviderParams, querystring: StartQuery } },
    async (req, reply) =>
      reply.redirect(await authorize(req, reply, req.params.provider, 'login', '')),
  );

  // M-1: an account created by OAuth sign-in confirms with a linked provider before it may
  // set its first password (POST /auth/password without a current one needs the grant).
  api.post(
    '/auth/oauth/:provider/setpw',
    {
      preHandler: ipLimit,
      schema: { params: ProviderParams, response: { 200: z.object({ authUrl: z.string() }) } },
    },
    async (req, reply) => {
      const ctx = requireUser(req);
      const { provider } = req.params;
      const user = await db
        .select({ hash: users.passwordHash })
        .from(users)
        .where(eq(users.id, ctx.userId))
        .get();
      if (user === undefined) throw new HttpError(401, 'unauthorized');
      if (hasUsablePassword(user.hash)) throw new HttpError(409, 'has_password');
      const linked = await db
        .select({ id: oauthAccounts.id })
        .from(oauthAccounts)
        .where(and(eq(oauthAccounts.userId, ctx.userId), eq(oauthAccounts.provider, provider)))
        .get();
      if (linked === undefined) throw new HttpError(409, 'not_linked');
      const authUrl = await authorize(req, reply, provider, 'setpw', sessionIdFrom(req) ?? '');
      return reply.code(200).send({ authUrl });
    },
  );

  api.post(
    '/auth/oauth/:provider/link',
    {
      preHandler: [ipLimit, ...reauthLimits(db)],
      schema: {
        params: ProviderParams,
        body: LinkBody,
        response: { 200: z.object({ authUrl: z.string() }) },
      },
    },
    async (req, reply) => {
      const ctx = requireUser(req);
      const { provider } = req.params;
      const user = await db
        .select({ hash: users.passwordHash })
        .from(users)
        .where(eq(users.id, ctx.userId))
        .get();
      if (user === undefined) throw new HttpError(401, 'unauthorized');
      // An account created by OAuth sign-in has no password to confirm: it sets one first.
      if (!hasUsablePassword(user.hash)) throw new HttpError(409, 'password_required');
      const confirmed = await confirmPassword(req, reply, {
        userId: ctx.userId,
        password: req.body.password,
        action: 'oauth.link',
      });
      if (!confirmed) return reply;
      const authUrl = await authorize(req, reply, provider, 'link', sessionIdFrom(req) ?? '');
      return reply.code(200).send({ authUrl });
    },
  );

  /** Login mode: which account (if any) this provider identity signs in to. */
  async function resolveLogin(
    provider: OAuthProvider,
    identity: OAuthIdentity,
  ): Promise<LoginOutcome> {
    return await withTransaction(db, async (tx): Promise<LoginOutcome> => {
      const linked = await tx
        .select({ userId: oauthAccounts.userId })
        .from(oauthAccounts)
        .where(
          and(
            eq(oauthAccounts.provider, provider),
            eq(oauthAccounts.providerAccountId, identity.providerAccountId),
          ),
        )
        .get();
      if (linked !== undefined) return { ok: true, userId: linked.userId, how: 'linked' };
      if (identity.email === null) return { ok: false, reason: 'no_email' };
      const match = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, identity.email))
        .get();
      // Review Focus 2 / ruling R2: an email never joins a provider account to an existing
      // one. Unverified proves nothing; verified proves only the mailbox.
      if (!identity.emailVerified) {
        return {
          ok: false,
          reason: 'unverified_email',
          ...(match === undefined ? {} : { userId: match.id }),
        };
      }
      if (match !== undefined) return { ok: false, reason: 'existing_account', userId: match.id };
      const now = Date.now();
      if (!(await isRegistrationOpen(tx))) return { ok: false, reason: 'registration_closed' };
      const userId = newId();
      const displayName = (identity.displayName ?? identity.email.split('@')[0] ?? 'New user')
        .trim()
        .slice(0, 100);
      await tx
        .insert(users)
        .values({
          id: userId,
          email: identity.email,
          passwordHash: unusablePasswordHash(),
          displayName: displayName.length > 0 ? displayName : 'New user',
          isAdmin: false,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      await tx
        .insert(oauthAccounts)
        .values({
          id: newId(),
          userId,
          provider,
          providerAccountId: identity.providerAccountId,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return { ok: true, userId, how: 'created' };
    });
  }

  async function finishLogin(
    req: FastifyRequest,
    reply: FastifyReply,
    provider: OAuthProvider,
    identity: OAuthIdentity,
  ) {
    let outcome: LoginOutcome;
    await racePoint('oauth.login');
    try {
      outcome = await resolveLogin(provider, identity);
    } catch (err) {
      // A concurrent callback linked or created the same thing first: start over.
      if (isUniqueViolation(err)) return reply.redirect(`${LOGIN_PAGE}?oauth=error`);
      throw err;
    }
    if (!outcome.ok) {
      const existing = outcome.reason === 'existing_account';
      await audit(db, existing ? 'auth.oauth_existing_account' : 'auth.oauth_unknown', {
        ...(outcome.userId === undefined ? {} : { userId: outcome.userId }),
        ip: req.ip,
        detail: { provider, reason: outcome.reason },
      });
      return reply.redirect(`${LOGIN_PAGE}?oauth=${existing ? 'existing_account' : 'unknown'}`);
    }
    const { userId, how } = outcome;
    if (how === 'created') {
      await audit(db, 'auth.register', {
        userId,
        ip: req.ip,
        detail: { isAdmin: false, method: 'oauth', provider },
      });
    }
    const user = await db
      .select({ totpEnabled: users.totpEnabled })
      .from(users)
      .where(eq(users.id, userId))
      .get();
    if (user === undefined) return reply.redirect(`${LOGIN_PAGE}?oauth=error`);
    if (user.totpEnabled) {
      // The provider stood in for the password; the code step is unchanged. The token rides
      // in the fragment, which browsers never send to a server or put in a Referer.
      const ua = req.headers['user-agent'];
      const pendingToken = await createPendingToken(db, userId, {
        ip: req.ip,
        ...(ua === undefined ? {} : { userAgent: ua }),
      });
      await audit(db, 'auth.2fa_challenge', {
        userId,
        ip: req.ip,
        detail: { method: 'oauth' },
      });
      return reply.redirect(`${LOGIN_PAGE}#pending2fa=${pendingToken}`);
    }
    await startUserSession(req, reply, userId);
    await audit(db, 'auth.login', {
      userId,
      ip: req.ip,
      detail: { method: 'oauth', provider },
    });
    return reply.redirect('/');
  }

  async function finishLink(
    req: FastifyRequest,
    reply: FastifyReply,
    provider: OAuthProvider,
    identity: OAuthIdentity,
  ) {
    const ctx = req.userCtx;
    if (ctx === null) return reply.redirect(`${LOGIN_PAGE}?oauth=session`);
    const flash = (v: string) => reply.redirect(`${SECURITY_PAGE}?oauth=${v}`);
    const userId = ctx.userId;
    type LinkOutcome = 'linked' | 'already_mine' | 'other_user' | 'provider_already_linked';
    let outcome: LinkOutcome;
    await racePoint('oauth.link');
    try {
      // One transaction under the user's scope: the checks and the insert cannot interleave
      // with another callback of this user (nothing indexes one account per provider per
      // user). The unique (provider, account) index stays the cross-user guard.
      outcome = await withTransaction(
        db,
        async (tx): Promise<LinkOutcome> => {
          const existing = await tx
            .select({ userId: oauthAccounts.userId })
            .from(oauthAccounts)
            .where(
              and(
                eq(oauthAccounts.provider, provider),
                eq(oauthAccounts.providerAccountId, identity.providerAccountId),
              ),
            )
            .get();
          if (existing !== undefined) {
            return existing.userId === userId ? 'already_mine' : 'other_user';
          }
          // One account per provider per user: a second flow that lost the race stops here.
          const mine = await tx
            .select({ id: oauthAccounts.id })
            .from(oauthAccounts)
            .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, provider)))
            .get();
          if (mine !== undefined) return 'provider_already_linked';
          await racePoint('oauth.link.locked');
          const now = Date.now();
          await tx
            .insert(oauthAccounts)
            .values({
              id: newId(),
              userId,
              provider,
              providerAccountId: identity.providerAccountId,
              createdAt: now,
              updatedAt: now,
            })
            .run();
          return 'linked';
        },
        { scope: `user:${userId}` },
      );
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      outcome = 'other_user';
    }
    if (outcome === 'already_mine') return flash('linked');
    if (outcome !== 'linked') {
      await audit(db, 'auth.oauth_link_conflict', {
        userId,
        ip: req.ip,
        detail: { provider, reason: outcome },
      });
      return flash('conflict');
    }
    await audit(db, 'auth.oauth_linked', {
      userId: ctx.userId,
      ip: req.ip,
      detail: { provider },
    });
    return flash('linked');
  }

  /** mode=setpw: the round trip must come back as the provider account this user linked. */
  async function finishSetPassword(
    req: FastifyRequest,
    reply: FastifyReply,
    provider: OAuthProvider,
    identity: OAuthIdentity,
  ) {
    const ctx = req.userCtx;
    const sessionId = sessionIdFrom(req);
    if (ctx === null || sessionId === null) return reply.redirect(`${LOGIN_PAGE}?oauth=session`);
    const row = await db
      .select({ userId: oauthAccounts.userId })
      .from(oauthAccounts)
      .where(
        and(
          eq(oauthAccounts.provider, provider),
          eq(oauthAccounts.providerAccountId, identity.providerAccountId),
        ),
      )
      .get();
    if (row?.userId !== ctx.userId) {
      await audit(db, 'auth.oauth_setpw_mismatch', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { provider },
      });
      return reply.redirect(`${SECURITY_PAGE}?oauth=setpw_mismatch`);
    }
    grantPasswordSet(db, sessionId, ctx.userId);
    await audit(db, 'auth.password_set_reauth', {
      userId: ctx.userId,
      ip: req.ip,
      detail: { provider },
    });
    return reply.redirect(`${SECURITY_PAGE}?oauth=setpw_ready`);
  }

  api.get(
    '/auth/oauth/:provider/callback',
    { preHandler: ipLimit, schema: { params: ProviderParams, querystring: CallbackQuery } },
    async (req, reply) => {
      const { provider } = req.params;
      const { code, state, error } = req.query;
      // Spent whatever happens.
      const binding = readBinding(req);
      reply.clearCookie(bindingCookieName(req), bindingCookie(req));
      const verified =
        state === undefined
          ? null
          : verifyOAuthState(app.config.masterKey, state, {
              provider,
              binding,
              sessionId: sessionIdFrom(req),
            });
      if (verified === null || !spendNonce(db, verified.nonce)) {
        await audit(db, 'auth.oauth_bad_state', {
          ...(req.userCtx === null ? {} : { userId: req.userCtx.userId }),
          ip: req.ip,
          detail: { provider, replay: verified !== null },
        });
        throw new HttpError(403, 'bad_state');
      }
      const mode: OAuthMode = verified.mode;
      // Where a failure lands, and its flash (setpw flashes are the Set-a-password card's).
      const fail = (what: 'denied' | 'error') =>
        reply.redirect(
          mode === 'login'
            ? `${LOGIN_PAGE}?oauth=${what}`
            : `${SECURITY_PAGE}?oauth=${mode === 'setpw' ? `setpw_${what}` : what}`,
        );
      if (error !== undefined || code === undefined) return fail('denied');
      const creds = await readProviderCreds(db, provider);
      if (creds === undefined) return fail('error');
      let identity: OAuthIdentity;
      try {
        identity = await exchangeAndIdentify(app.oauth.fetch, provider, {
          creds,
          code,
          redirectUri: redirectUriFor(baseUrl, provider),
          ...(providerUsesPkce(provider)
            ? { codeVerifier: pkceVerifier(app.config.masterKey, binding, verified.nonce) }
            : {}),
        });
      } catch (err) {
        // The message names the step and status only; never the request (client secret).
        req.log.warn(
          { provider, reason: err instanceof Error ? err.message : 'unknown' },
          'oauth sign-in exchange failed',
        );
        return fail('error');
      }
      if (mode === 'link') return finishLink(req, reply, provider, identity);
      if (mode === 'setpw') return finishSetPassword(req, reply, provider, identity);
      return finishLogin(req, reply, provider, identity);
    },
  );

  api.get(
    '/auth/oauth/accounts',
    { schema: { response: { 200: LinkedAccounts } } },
    async (req) => {
      const ctx = requireUser(req);
      const user = await db
        .select({ hash: users.passwordHash })
        .from(users)
        .where(eq(users.id, ctx.userId))
        .get();
      const accounts = (
        await db
          .select({ provider: oauthAccounts.provider, createdAt: oauthAccounts.createdAt })
          .from(oauthAccounts)
          .where(eq(oauthAccounts.userId, ctx.userId))
          .all()
      ).flatMap((a) => {
        const p = OAUTH_PROVIDERS.find((x) => x === a.provider);
        return p === undefined ? [] : [{ provider: p, createdAt: a.createdAt }];
      });
      return { hasPassword: user !== undefined && hasUsablePassword(user.hash), accounts };
    },
  );

  api.delete(
    '/auth/oauth/:provider',
    {
      preHandler: reauthLimits(db),
      schema: { params: ProviderParams, body: UnlinkBody, response: { 204: z.null() } },
    },
    async (req, reply) => {
      const ctx = requireUser(req);
      const { provider } = req.params;
      const row = await db
        .select({ id: oauthAccounts.id })
        .from(oauthAccounts)
        .where(and(eq(oauthAccounts.userId, ctx.userId), eq(oauthAccounts.provider, provider)))
        .get();
      if (row === undefined) throw new HttpError(404, 'not_linked');
      const user = await db
        .select({ hash: users.passwordHash })
        .from(users)
        .where(eq(users.id, ctx.userId))
        .get();
      if (user === undefined) throw new HttpError(401, 'unauthorized');
      if (hasUsablePassword(user.hash)) {
        // The Wave-1 re-auth convention: a credential change takes the current password.
        const confirmed = await confirmPassword(req, reply, {
          userId: ctx.userId,
          password: req.body.password ?? '',
          action: 'oauth.unlink',
        });
        if (!confirmed) return reply;
      } else {
        // No password to confirm: refuse to remove the last way in, and otherwise ask for a
        // password first (Settings > Security) like every other credential change.
        const linked =
          (
            await db
              .select({ n: count() })
              .from(oauthAccounts)
              .where(eq(oauthAccounts.userId, ctx.userId))
              .get()
          )?.n ?? 0;
        throw new HttpError(409, linked <= 1 ? 'last_method' : 'password_required');
      }
      await db.delete(oauthAccounts).where(eq(oauthAccounts.id, row.id)).run();
      await audit(db, 'auth.oauth_unlinked', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { provider },
      });
      return reply.code(204).send(null);
    },
  );

  // Public: the login page shows a button per configured provider.
  api.get(
    '/auth/oauth/providers',
    { schema: { response: { 200: z.object({ providers: z.array(z.enum(OAUTH_PROVIDERS)) }) } } },
    async () => {
      const providers: (typeof OAUTH_PROVIDERS)[number][] = [];
      for (const p of OAUTH_PROVIDERS) if (await providerConfigured(db, p)) providers.push(p);
      return { providers };
    },
  );
}
