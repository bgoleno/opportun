// End-to-end OAuth sign-in mock (OPPORTUN_OAUTH_MOCK=1): stands in for the providers' token
// and userinfo endpoints (the app's oauth fetch). The browser half, the provider's consent
// page, is intercepted by the e2e itself (page.route) and answered with a redirect to the
// callback carrying a code made by mockOAuthCode. The code IS the identity the fake provider
// reports, so a test chooses who signs in. Never enabled in production (testSupport/index.ts).
import { LINKEDIN_TOKEN_URL, LINKEDIN_USERINFO_URL } from '../lib/oauthProviders';
import type { SafeFetchOptions, SafeFetchResponse } from '../lib/safeFetch';

export interface MockOAuthIdentity {
  id: string;
  email: string | null;
  emailVerified: boolean;
  name?: string;
}

const PREFIX = 'e2e.';

/** The authorization code a fake provider would send back for this identity. */
export function mockOAuthCode(identity: MockOAuthIdentity): string {
  return PREFIX + Buffer.from(JSON.stringify(identity)).toString('base64url');
}

function decode(token: string): MockOAuthIdentity | undefined {
  if (!token.startsWith(PREFIX)) return undefined;
  try {
    return JSON.parse(
      Buffer.from(token.slice(PREFIX.length), 'base64url').toString('utf8'),
    ) as MockOAuthIdentity;
  } catch {
    return undefined;
  }
}

function json(status: number, body: unknown, url: string): SafeFetchResponse {
  return {
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: Buffer.from(JSON.stringify(body)),
    url,
  };
}

export async function mockOAuthFetch(
  url: string,
  opts: SafeFetchOptions,
): Promise<SafeFetchResponse> {
  if (
    url === 'https://oauth2.googleapis.com/token' ||
    url === 'https://github.com/login/oauth/access_token' ||
    url === LINKEDIN_TOKEN_URL
  ) {
    const code = new URLSearchParams(opts.post?.body ?? '').get('code') ?? '';
    // The access token is the code again: the userinfo calls decode it.
    return decode(code) === undefined
      ? json(400, { error: 'invalid_grant' }, url)
      : json(200, { access_token: code, token_type: 'bearer' }, url);
  }
  const identity = decode((opts.headers?.authorization ?? '').replace(/^Bearer /, ''));
  if (identity === undefined) return json(401, { message: 'Bad credentials' }, url);
  if (url === 'https://openidconnect.googleapis.com/v1/userinfo' || url === LINKEDIN_USERINFO_URL) {
    return json(
      200,
      {
        sub: identity.id,
        ...(identity.email === null
          ? {}
          : { email: identity.email, email_verified: identity.emailVerified }),
        name: identity.name ?? 'E2E Google User',
      },
      url,
    );
  }
  if (url === 'https://api.github.com/user') {
    return json(200, { id: Number(identity.id), login: 'e2e', name: identity.name ?? null }, url);
  }
  if (url === 'https://api.github.com/user/emails') {
    return json(
      200,
      identity.email === null
        ? []
        : [{ email: identity.email, primary: true, verified: identity.emailVerified }],
      url,
    );
  }
  return json(404, { error: 'not_found' }, url);
}
