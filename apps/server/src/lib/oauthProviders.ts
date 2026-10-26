// OAuth sign-in providers (FR-S4): the registry of endpoints, the instance-level client
// credentials an admin configures, the code exchange and the identity lookup. Every outbound
// call goes through the injected safeFetch with allowHosts pinned to exactly the host called;
// token requests carry a body and the userinfo requests a credential header, so safeFetch
// refuses any redirect on both (the endpoints below are the providers' canonical URLs).

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { settings } from '../db/schema';
import { OFFICIAL_API_URLS, type safeFetch } from './safeFetch';
import { decryptSecret, encryptSecret } from './secretBox';

export const OAUTH_PROVIDERS = ['google', 'github', 'linkedin'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export type OAuthFetch = typeof safeFetch;

// LinkedIn's token and userinfo endpoints are the C-1 official-API carve-out, owned by
// safeFetch.ts (OFFICIAL_API_URLS): each call passes its own URL as officialApiUrl plus an
// allowHosts of its own host, and safeFetch refuses anything else on the domain.
export const LINKEDIN_TOKEN_URL = OFFICIAL_API_URLS.linkedinToken;
export const LINKEDIN_USERINFO_URL = OFFICIAL_API_URLS.linkedinUserinfo;
const OFFICIAL: readonly string[] = Object.values(OFFICIAL_API_URLS);
/** The consent page: a browser navigation, never fetched by the server. */
const LINKEDIN_AUTHORIZE_URL = new URL('/oauth/v2/authorization', LINKEDIN_TOKEN_URL).href;

/**
 * safeFetch options for one provider call: allowHosts pinned to exactly the host called, and,
 * only for the two official LinkedIn endpoints, the exact-URL override of the prohibition.
 */
export function providerFetchOptions(url: string): {
  allowHosts: string[];
  officialApiUrl?: string;
} {
  const allowHosts = [new URL(url).hostname];
  return OFFICIAL.includes(url) ? { allowHosts, officialApiUrl: url } : { allowHosts };
}

/** What a provider tells us about the person who consented. */
export interface OAuthIdentity {
  providerAccountId: string;
  /** Lower-cased; null when the provider shares none. */
  email: string | null;
  /** True only when the provider itself says it verified this address. */
  emailVerified: boolean;
  displayName: string | null;
}

export interface ClientCreds {
  clientId: string;
  clientSecret: string;
}

interface ProviderDef {
  /** False when the provider cannot be used on this instance (see the file header). */
  available: boolean;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  /** PKCE (S256) on the authorization request and the token exchange. */
  pkce: boolean;
  /** Extra headers for the token request (GitHub answers form-encoded without Accept). */
  tokenHeaders?: Record<string, string>;
  identity: (fetch: OAuthFetch, accessToken: string) => Promise<OAuthIdentity>;
}

const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;

export class OAuthProviderError extends Error {
  override name = 'OAuthProviderError';
}

/** A JSON GET with a bearer token, pinned to the URL's own host. */
async function getJson(fetch: OAuthFetch, url: string, accessToken: string): Promise<unknown> {
  const res = await fetch(url, {
    ...providerFetchOptions(url),
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    maxBytes: MAX_BYTES,
    timeoutMs: TIMEOUT_MS,
  });
  if (res.status !== 200) throw new OAuthProviderError(`${new URL(url).pathname}: ${res.status}`);
  try {
    return JSON.parse(res.body.toString('utf8')) as unknown;
  } catch {
    throw new OAuthProviderError(`${new URL(url).pathname}: not JSON`);
  }
}

const OidcUserinfo = z.object({
  sub: z.string().min(1).max(255),
  email: z.string().max(254).optional(),
  // Google sends a boolean; some OIDC providers send the string "true".
  email_verified: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
  name: z.string().max(200).optional(),
});

async function oidcIdentity(fetch: OAuthFetch, url: string, accessToken: string) {
  const info = OidcUserinfo.parse(await getJson(fetch, url, accessToken));
  const email = info.email?.trim().toLowerCase() || null;
  return {
    providerAccountId: info.sub,
    email,
    emailVerified:
      email !== null && (info.email_verified === true || info.email_verified === 'true'),
    displayName: info.name?.trim() || null,
  };
}

const GithubUser = z.object({
  id: z.number().int(),
  login: z.string().max(100),
  name: z.string().max(200).nullable().optional(),
});
const GithubEmails = z.array(
  z.object({ email: z.string().max(254), primary: z.boolean(), verified: z.boolean() }),
);

async function githubIdentity(fetch: OAuthFetch, accessToken: string): Promise<OAuthIdentity> {
  const user = GithubUser.parse(await getJson(fetch, 'https://api.github.com/user', accessToken));
  const emails = GithubEmails.parse(
    await getJson(fetch, 'https://api.github.com/user/emails', accessToken),
  );
  // Only the PRIMARY address counts, and only GitHub's own verified flag on it; the public
  // profile email on /user is user-entered and never trusted.
  const primary = emails.find((e) => e.primary);
  const email = primary?.email.trim().toLowerCase() || null;
  return {
    providerAccountId: String(user.id),
    email,
    emailVerified: email !== null && primary?.verified === true,
    displayName: user.name?.trim() || user.login,
  };
}

const PROVIDERS: Record<OAuthProvider, ProviderDef> = {
  google: {
    available: true,
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    pkce: true,
    identity: (fetch, token) =>
      oidcIdentity(fetch, 'https://openidconnect.googleapis.com/v1/userinfo', token),
  },
  github: {
    available: true,
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
    // GitHub OAuth Apps accept PKCE (S256) alongside the client secret.
    pkce: true,
    tokenHeaders: { accept: 'application/json' },
    identity: githubIdentity,
  },
  linkedin: {
    available: true,
    authorizeUrl: LINKEDIN_AUTHORIZE_URL,
    tokenUrl: LINKEDIN_TOKEN_URL,
    scope: 'openid profile email',
    pkce: false,
    identity: (fetch, token) => oidcIdentity(fetch, LINKEDIN_USERINFO_URL, token),
  },
};

export function providerAvailable(provider: OAuthProvider): boolean {
  // eslint-disable-next-line security/detect-object-injection -- provider is a validated enum
  return PROVIDERS[provider].available;
}

export function providerUsesPkce(provider: OAuthProvider): boolean {
  // eslint-disable-next-line security/detect-object-injection -- provider is a validated enum
  return PROVIDERS[provider].pkce;
}

export const oauthCallbackPath = (provider: OAuthProvider): string =>
  `/api/v1/auth/oauth/${provider}/callback`;

export function redirectUriFor(baseUrl: string, provider: OAuthProvider): string {
  return baseUrl + oauthCallbackPath(provider);
}

// ---------------------------------------------------------------------------
// Instance-level client credentials: a settings row with no user (like registration_open),
// whose secret is sealed with the vault key (encryptSecret), never stored in plaintext.

const settingKey = (provider: OAuthProvider) => `oauth_provider:${provider}`;

const StoredCreds = z.object({ clientId: z.string(), sealedSecret: z.string() });

export async function writeProviderCreds(
  db: Db,
  provider: OAuthProvider,
  creds: ClientCreds,
): Promise<void> {
  const now = Date.now();
  const value = { clientId: creds.clientId, sealedSecret: encryptSecret(db, creds.clientSecret) };
  await db
    .insert(settings)
    .values({ key: settingKey(provider), userId: null, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
    .run();
}

export async function readProviderCreds(
  db: Db,
  provider: OAuthProvider,
): Promise<ClientCreds | undefined> {
  if (!providerAvailable(provider)) return undefined;
  const row = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, settingKey(provider)))
    .get();
  const parsed = StoredCreds.safeParse(row?.value);
  if (!parsed.success) return undefined;
  return {
    clientId: parsed.data.clientId,
    clientSecret: decryptSecret(db, parsed.data.sealedSecret),
  };
}

/**
 * The stored client id, or undefined when the provider has no credentials. An id is not a
 * secret (it travels in every authorize URL), but it is still never echoed to a caller: this
 * exists so the server can compare one client with another without unsealing either secret.
 */
export async function readProviderClientId(
  db: Db,
  provider: OAuthProvider,
): Promise<string | undefined> {
  if (!providerAvailable(provider)) return undefined;
  const row = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, settingKey(provider)))
    .get();
  const parsed = StoredCreds.safeParse(row?.value);
  return parsed.success ? parsed.data.clientId : undefined;
}

export async function providerConfigured(db: Db, provider: OAuthProvider): Promise<boolean> {
  return (await readProviderClientId(db, provider)) !== undefined;
}

export async function deleteProviderCreds(db: Db, provider: OAuthProvider): Promise<void> {
  await db
    .delete(settings)
    .where(eq(settings.key, settingKey(provider)))
    .run();
}

// ---------------------------------------------------------------------------
// The authorization request and the code exchange

/** RFC 7636 S256 challenge for a verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function buildAuthorizeUrl(
  provider: OAuthProvider,
  opts: {
    clientId: string;
    redirectUri: string;
    state: string;
    codeVerifier?: string;
  },
): string {
  // eslint-disable-next-line security/detect-object-injection -- provider is a validated enum
  const def = PROVIDERS[provider];
  const url = new URL(def.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('scope', def.scope);
  url.searchParams.set('state', opts.state);
  if (def.pkce && opts.codeVerifier !== undefined) {
    url.searchParams.set('code_challenge', pkceChallenge(opts.codeVerifier));
    url.searchParams.set('code_challenge_method', 'S256');
  }
  if (provider === 'google') url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

const TokenResponse = z.object({ access_token: z.string().min(1).max(4096) });

/**
 * Exchanges an authorization code for an access token and returns the identity behind it.
 * Throws OAuthProviderError (or a FetchBlockedError) on any failure; the error never carries
 * the request body, so it is safe to log its message.
 */
export async function exchangeAndIdentify(
  fetch: OAuthFetch,
  provider: OAuthProvider,
  opts: { creds: ClientCreds; code: string; redirectUri: string; codeVerifier?: string },
): Promise<OAuthIdentity> {
  // eslint-disable-next-line security/detect-object-injection -- provider is a validated enum
  const def = PROVIDERS[provider];
  if (!def.available) throw new OAuthProviderError(`${provider} is unavailable`);
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.creds.clientId,
    client_secret: opts.creds.clientSecret,
  });
  if (def.pkce && opts.codeVerifier !== undefined) form.set('code_verifier', opts.codeVerifier);
  const res = await fetch(def.tokenUrl, {
    ...providerFetchOptions(def.tokenUrl),
    post: { contentType: 'application/x-www-form-urlencoded', body: form.toString() },
    ...(def.tokenHeaders === undefined ? {} : { headers: def.tokenHeaders }),
    maxBytes: MAX_BYTES,
    timeoutMs: TIMEOUT_MS,
  });
  if (res.status !== 200) throw new OAuthProviderError(`token endpoint: ${res.status}`);
  let body: unknown;
  try {
    body = JSON.parse(res.body.toString('utf8'));
  } catch {
    throw new OAuthProviderError('token endpoint: not JSON');
  }
  // GitHub reports a bad code as 200 {error}: no access_token means failure either way.
  const parsed = TokenResponse.safeParse(body);
  if (!parsed.success) throw new OAuthProviderError('token endpoint: no access token');
  try {
    return await def.identity(fetch, parsed.data.access_token);
  } catch (err) {
    if (err instanceof z.ZodError) throw new OAuthProviderError('userinfo: unexpected shape');
    throw err;
  }
}
