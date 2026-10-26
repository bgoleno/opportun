// Google OAuth client validation. Google has no API that creates or inspects an OAuth client,
// so the check is a live probe of the token endpoint with a code that cannot be valid:
//   401 invalid_client  -> the id and secret do not match a live client (invalid);
//   400 invalid_grant   -> the client authenticated and only the code was refused (valid);
//   anything else, a timeout or a network error -> unverified (the credentials stay stored).
// The secret goes only to oauth2.googleapis.com, in a POST body that never follows a redirect,
// and never appears in a result, an error or a log line.
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { settings } from '../db/schema';
import type { UserCtx } from '../repos/base';
import { readSetting, writeSetting } from './ai';
import type { GoogleClientCreds } from './google';
import type { safeFetch } from './safeFetch';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_TOKEN_HOST = 'oauth2.googleapis.com';
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_BYTES = 64 * 1024;

export const CLIENT_ID_SUFFIX = /\.apps\.googleusercontent\.com$/;

export const FIX_CLIENT_ID_FORMAT =
  'Copy the Client ID from the OAuth client you created; it ends with .apps.googleusercontent.com';
export const FIX_INVALID_CLIENT =
  'The ID and secret do not match a live OAuth client. Re-copy both from the SAME client in the console, and check for truncation.';
export const FIX_UNVERIFIED =
  'Google could not be reached to check the client. It is saved; retry the check in a minute.';
export const WARN_SECRET_PREFIX =
  'Current client secrets start with GOCSPX-. An older secret can still work; if sign-in fails, add a new secret to the client and use that.';

export const GOOGLE_VALIDATION_STATUSES = ['valid', 'invalid', 'unverified'] as const;

export const GoogleClientValidationSchema = z.object({
  ok: z.boolean(),
  status: z.enum(GOOGLE_VALIDATION_STATUSES),
  error: z.string().optional(),
  fix: z.string().optional(),
  warning: z.string().optional(),
  checkedAt: z.number().int(),
});
export type GoogleClientValidation = z.infer<typeof GoogleClientValidationSchema>;

export const googleValidationKey = (userId: string): string => `google_client_validation:${userId}`;

/** Format pre-checks: an invalid result when the id cannot be a Google client id, else null. */
export function formatCheck(
  creds: GoogleClientCreds,
  now: number = Date.now(),
): GoogleClientValidation | null {
  if (!CLIENT_ID_SUFFIX.test(creds.clientId)) {
    return {
      ok: false,
      status: 'invalid',
      error: 'client_id_format',
      fix: FIX_CLIENT_ID_FORMAT,
      checkedAt: now,
    };
  }
  return null;
}

/** The warn-level note for a secret without the current GOCSPX- prefix (not an error). */
export function secretWarning(clientSecret: string): string | undefined {
  return clientSecret.startsWith('GOCSPX-') ? undefined : WARN_SECRET_PREFIX;
}

const TokenError = z.object({ error: z.string().max(200) });

/** Google's OAuth error code from a token endpoint body, when it has one. */
function oauthError(body: Buffer): string | undefined {
  try {
    const parsed = TokenError.safeParse(JSON.parse(body.toString('utf8')));
    return parsed.success ? parsed.data.error : undefined;
  } catch {
    return undefined;
  }
}

/** Probes the token endpoint (see the header comment). Never throws. */
export async function probeGoogleClient(
  fetch: typeof safeFetch,
  creds: GoogleClientCreds,
  redirectUri: string,
): Promise<GoogleClientValidation> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: 'invalid-probe',
    redirect_uri: redirectUri,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
  const warning = secretWarning(creds.clientSecret);
  const base = warning === undefined ? {} : { warning };
  const unverified = (): GoogleClientValidation => ({
    ...base,
    ok: false,
    status: 'unverified',
    error: 'unreachable',
    fix: FIX_UNVERIFIED,
    checkedAt: Date.now(),
  });
  let res;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      allowHosts: [GOOGLE_TOKEN_HOST],
      timeoutMs: PROBE_TIMEOUT_MS,
      maxBytes: PROBE_MAX_BYTES,
      post: { contentType: 'application/x-www-form-urlencoded', body: form.toString() },
    });
  } catch {
    // The error is not inspected or logged: a transport error could echo the request.
    return unverified();
  }
  const code = oauthError(res.body);
  if (res.status === 401 || code === 'invalid_client') {
    return {
      ...base,
      ok: false,
      status: 'invalid',
      error: 'invalid_client',
      fix: FIX_INVALID_CLIENT,
      checkedAt: Date.now(),
    };
  }
  if (res.status === 400 && code === 'invalid_grant') {
    return { ...base, ok: true, status: 'valid', checkedAt: Date.now() };
  }
  return unverified();
}

/** Format check, then the live probe. */
export async function validateGoogleClient(
  fetch: typeof safeFetch,
  creds: GoogleClientCreds,
  redirectUri: string,
): Promise<GoogleClientValidation> {
  return formatCheck(creds) ?? probeGoogleClient(fetch, creds, redirectUri);
}

export async function storeGoogleValidation(
  db: Db,
  ctx: UserCtx,
  v: GoogleClientValidation,
): Promise<void> {
  await writeSetting(db, ctx, googleValidationKey(ctx.userId), v);
}

/** The last stored validation of the caller's client, or null. */
export async function readGoogleValidation(
  db: Db,
  ctx: UserCtx,
): Promise<GoogleClientValidation | null> {
  const parsed = GoogleClientValidationSchema.safeParse(
    await readSetting(db, ctx, googleValidationKey(ctx.userId)),
  );
  return parsed.success ? parsed.data : null;
}

export async function deleteGoogleValidation(db: Db, ctx: UserCtx): Promise<void> {
  await db
    .delete(settings)
    .where(and(eq(settings.key, googleValidationKey(ctx.userId)), eq(settings.userId, ctx.userId)))
    .run();
}
