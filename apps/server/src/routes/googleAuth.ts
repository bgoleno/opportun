// Google account connection API (C-3, NFR-SEC10). Client credentials and tokens go into the
// secrets vault and never come back out; responses carry connection status only.
import {
  AiUnavailableError,
  DiagnoseOutputSchema,
  renderPrompt,
  runStructured,
} from '@opportun/ai';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { aiAvailable, buildAiDeps, expiredKeyHint } from '../lib/ai';
import { audit } from '../lib/audit';
import { HttpError } from '../lib/errors';
import {
  buildAuthUrl,
  deleteGoogleSecrets,
  GOOGLE_CALLBACK_PATH,
  GOOGLE_SCOPE_SET_NAMES,
  GOOGLE_SCOPE_SETS,
  mergeTokens,
  newOAuthClient,
  readClientCreds,
  readTokens,
  sessionIdOf,
  signState,
  verifyState,
  writeClientCreds,
  writeTokens,
} from '../lib/google';
import {
  deleteGoogleValidation,
  GoogleClientValidationSchema,
  readGoogleValidation,
  storeGoogleValidation,
  validateGoogleClient,
  type GoogleClientValidation,
} from '../lib/googleValidate';
import { spendNonce } from '../lib/oauthState';
import { redirectUriFor } from '../lib/oauthProviders';
import { requireUser } from '../repos/base';
import { getActivePrompt } from '../repos/prompts';

const SETTINGS_PAGE = '/settings/integrations';

const ClientBody = z.object({
  clientId: z.string().trim().min(1).max(300),
  clientSecret: z.string().trim().min(1).max(500),
});
const ConnectQuery = z.object({ scopes: z.enum(GOOGLE_SCOPE_SET_NAMES) });
const CallbackQuery = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(1024).optional(),
  error: z.string().max(200).optional(),
});
const StatusSchema = z.object({
  connected: z.boolean(),
  scopes: z.array(z.string()),
  email: z.string().optional(),
  clientConfigured: z.boolean(),
  /** The stored OAuth client id, echoed for display (a public identifier per RFC 6749;
   *  it already appears in every consent URL). The secret never leaves the vault. */
  clientId: z.string().nullable(),
  /** The exact redirect URI to register on the OAuth client (from BASE_URL). */
  redirectUri: z.string(),
  /** The authorized JavaScript origin to register (BASE_URL's origin). */
  jsOrigin: z.string(),
  /** The redirect URI "Sign in with Google" sends. Sign-in can reuse this client, and Google
   *  rejects it with redirect_uri_mismatch unless it is registered next to `redirectUri`. */
  signInRedirectUri: z.string(),
  /** Whether the caller has an AI key, so the diagnose assist can run. */
  aiAvailable: z.boolean(),
  /** The last check of the stored client; null before any. */
  validation: GoogleClientValidationSchema.nullable(),
});
const SaveResponse = z.object({
  /** False only when the format check refused the credentials before storage. */
  stored: z.boolean(),
  validation: GoogleClientValidationSchema,
});
export const DIAGNOSE_MAX_CHARS = 5000;
const DiagnoseBody = z.object({ text: z.string().trim().min(1).max(DIAGNOSE_MAX_CHARS) }).strict();
const DIAGNOSE_MANUAL_HINT =
  "AI diagnosis is unavailable. Compare the error with the redirect URI, JavaScript origin, consent screen audience and test users shown in the guided setup, or see Google's OAuth client help page.";

export async function googleAuthRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  const redirectUri = app.config.baseUrl + GOOGLE_CALLBACK_PATH;
  const jsOrigin = new URL(app.config.baseUrl).origin;
  const signInRedirectUri = redirectUriFor(app.config.baseUrl, 'google');

  /** The caller's session token; requireUser has already proven it is present and valid. */
  const sessionId = (token: string | undefined): string => sessionIdOf(token ?? '');

  api.post(
    '/integrations/google/client',
    { schema: { body: ClientBody, response: { 200: SaveResponse } } },
    async (req) => {
      const ctx = requireUser(req);
      const validation = await validateGoogleClient(app.googleFetch, req.body, redirectUri);
      // A malformed id is refused before storage; a failed or unreachable probe is stored
      // anyway (never block storage on Google being down) with its status and fix.
      if (validation.error === 'client_id_format') return { stored: false, validation };
      await writeClientCreds(db, ctx, req.body);
      await storeGoogleValidation(db, ctx, validation);
      await audit(db, 'google.client_configured', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { validation: validation.status },
      });
      return { stored: true, validation };
    },
  );

  api.post(
    '/integrations/google/client/validate',
    { schema: { response: { 200: z.object({ validation: GoogleClientValidationSchema }) } } },
    async (req) => {
      const ctx = requireUser(req);
      const creds = await readClientCreds(db, ctx);
      if (creds === undefined) throw new HttpError(409, 'google_not_configured');
      const validation: GoogleClientValidation = await validateGoogleClient(
        app.googleFetch,
        creds,
        redirectUri,
      );
      await storeGoogleValidation(db, ctx, validation);
      return { validation };
    },
  );

  api.post(
    '/integrations/google/diagnose',
    { schema: { body: DiagnoseBody, response: { 200: DiagnoseOutputSchema } } },
    async (req) => {
      const ctx = requireUser(req);
      const unavailable = (reason: string, keyHint?: string) =>
        new HttpError(503, 'ai_unavailable', undefined, {
          reason,
          hint:
            keyHint === undefined ? DIAGNOSE_MANUAL_HINT : `${DIAGNOSE_MANUAL_HINT} (${keyHint})`,
        });
      if (!(await aiAvailable(db, ctx))) throw unavailable('no_key');
      const prompt = await getActivePrompt(db, ctx, 'integration.diagnose');
      if (prompt === undefined) throw unavailable('no_prompt');
      try {
        return await runStructured(await buildAiDeps(db, ctx), 'integration.diagnose', {
          system: renderPrompt(prompt.body, { error_untrusted: req.body.text }),
          // App-written context, outside the fence: the values this server expects.
          prompt: `This app's redirect URI is ${redirectUri} and its authorized JavaScript origin is ${jsOrigin}. Explain the error and give the fix.`,
          schema: DiagnoseOutputSchema,
          promptId: prompt.id,
        });
      } catch (err) {
        if (err instanceof AiUnavailableError) {
          throw unavailable(err.reason, await expiredKeyHint(db, ctx, 'integration.diagnose', err));
        }
        throw err;
      }
    },
  );

  api.get(
    '/integrations/google/connect',
    { schema: { querystring: ConnectQuery, response: { 200: z.object({ authUrl: z.string() }) } } },
    async (req) => {
      const ctx = requireUser(req);
      const creds = await readClientCreds(db, ctx);
      if (creds === undefined) throw new HttpError(409, 'google_not_configured');
      const scopeSet = req.query.scopes;
      const state = signState(
        app.config.masterKey,
        sessionId(req.cookies.opportun_session),
        ctx.userId,
        scopeSet,
      );
      // eslint-disable-next-line security/detect-object-injection -- scopeSet is a validated enum
      const scopes = GOOGLE_SCOPE_SETS[scopeSet];
      return { authUrl: buildAuthUrl(newOAuthClient(creds, redirectUri), scopes, state) };
    },
  );

  api.get(
    '/integrations/google/callback',
    { schema: { querystring: CallbackQuery }, config: { reportsSessionErrors: true } },
    async (req, reply) => {
      let ctx;
      try {
        ctx = requireUser(req);
      } catch {
        // Two different things land here, and they call for different messages (issue
        // #108): a lookup that correctly found no session (typically the user started
        // Connect while browsing another origin than BASE_URL, since cookies do not cross
        // hosts) versus a lookup that itself failed. A JSON 401 would be a dead end mid-flow
        // either way, so land them in the app with a flash explaining which happened.
        const reason = req.sessionLookupFailed ? 'unavailable' : 'session';
        return reply.redirect(`${SETTINGS_PAGE}?google=${reason}`);
      }
      const { code, state, error } = req.query;
      const verified =
        state === undefined
          ? null
          : verifyState(
              app.config.masterKey,
              state,
              sessionId(req.cookies.opportun_session),
              ctx.userId,
            );
      // Single use, like the sign-in flow: the nonce is spent on this callback whatever
      // happens next, so a state replayed inside its ten minute window is refused.
      if (verified === null || !spendNonce(db, verified.nonce)) {
        await audit(db, 'google.bad_state', {
          userId: ctx.userId,
          ip: req.ip,
          detail: { replay: verified !== null },
        });
        throw new HttpError(403, 'bad_state');
      }
      const scopeSet = verified.scopeSet;
      if (error !== undefined || code === undefined) {
        return reply.redirect(`${SETTINGS_PAGE}?google=denied`);
      }
      const creds = await readClientCreds(db, ctx);
      if (creds === undefined) throw new HttpError(409, 'google_not_configured');
      const client = newOAuthClient(creds, redirectUri);
      let tokens;
      try {
        tokens = await app.google.exchangeCode(client, code);
      } catch {
        // The error is not logged: it carries the token request, client secret included.
        req.log.warn('google token exchange failed');
        return reply.redirect(`${SETTINGS_PAGE}?google=error`);
      }
      const merged = mergeTokens(await readTokens(db, ctx), tokens);
      client.setCredentials(tokens);
      try {
        const email = await app.google.accountEmail(client);
        if (email !== undefined) merged.email = email;
      } catch {
        // Best effort: status shows no address.
      }
      await writeTokens(db, ctx, merged);
      await audit(db, 'google.connected', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { scopeSet, scopes: merged.scopes },
      });
      return reply.redirect(SETTINGS_PAGE);
    },
  );

  api.get('/integrations/google', { schema: { response: { 200: StatusSchema } } }, async (req) => {
    const ctx = requireUser(req);
    const tokens = await readTokens(db, ctx);
    const creds = await readClientCreds(db, ctx);
    const clientConfigured = creds !== undefined;
    const connected =
      tokens !== undefined && (tokens.refreshToken !== null || tokens.accessToken !== null);
    return {
      connected,
      scopes: connected ? tokens.scopes : [],
      ...(connected && tokens.email !== undefined ? { email: tokens.email } : {}),
      clientConfigured,
      clientId: creds?.clientId ?? null,
      redirectUri,
      jsOrigin,
      signInRedirectUri,
      aiAvailable: await aiAvailable(db, ctx),
      validation: clientConfigured ? await readGoogleValidation(db, ctx) : null,
    };
  });

  api.delete(
    '/integrations/google',
    { schema: { response: { 204: z.null() } } },
    async (req, reply) => {
      const ctx = requireUser(req);
      const tokens = await readTokens(db, ctx);
      const creds = await readClientCreds(db, ctx);
      const token = tokens?.refreshToken ?? tokens?.accessToken ?? null;
      if (token !== null && creds !== undefined) {
        try {
          await app.google.revokeToken(newOAuthClient(creds, redirectUri), token);
        } catch {
          // Revocation is best effort (an already revoked token fails); the secrets go anyway.
          req.log.warn('google token revocation failed');
        }
      }
      await deleteGoogleSecrets(db, ctx);
      await deleteGoogleValidation(db, ctx);
      await audit(db, 'google.disconnected', { userId: ctx.userId, ip: req.ip });
      return reply.code(204).send(null);
    },
  );
}
