// An in-memory stand-in for the OAuth sign-in providers' token and userinfo endpoints, injected
// as the app's oauthFetch (BuildOptions.oauth.fetch). Tests never reach the network. It checks
// what a careful caller must do: every request names exactly its own host in allowHosts, and
// every token exchange carries the client credentials and the redirect URI.
import type { SafeFetchOptions, SafeFetchResponse } from '../src/lib/safeFetch';

export interface FakeIdentity {
  /** Provider account id (google `sub`, github numeric `id`). */
  id: string;
  email: string | null;
  emailVerified: boolean;
  name?: string;
}

export interface FakeCall {
  url: string;
  opts: SafeFetchOptions;
  /** The form body of a token exchange, parsed. */
  form?: URLSearchParams;
}

export interface FakeOAuth {
  fetch: (url: string, opts: SafeFetchOptions) => Promise<SafeFetchResponse>;
  /** Code -> identity the provider will report for it. */
  codes: Map<string, FakeIdentity>;
  calls: FakeCall[];
  /** When set, the token endpoint answers this status. */
  tokenStatus: number | null;
  /** Issues a code for an identity (as the provider would after consent). */
  issue(identity: FakeIdentity): string;
}

const LINKEDIN_TOKEN = 'https://www.linkedin.com/oauth/v2/accessToken';
const LINKEDIN_USERINFO = 'https://api.linkedin.com/v2/userinfo';
const TOKEN_URLS = new Set([
  'https://oauth2.googleapis.com/token',
  'https://github.com/login/oauth/access_token',
  LINKEDIN_TOKEN,
]);

function json(status: number, body: unknown, url: string): SafeFetchResponse {
  return {
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: Buffer.from(JSON.stringify(body)),
    url,
  };
}

let counter = 0;

export function fakeOAuth(): FakeOAuth {
  const codes = new Map<string, FakeIdentity>();
  /** access token -> identity */
  const tokens = new Map<string, FakeIdentity>();
  const calls: FakeCall[] = [];
  const fake: FakeOAuth = {
    codes,
    calls,
    tokenStatus: null,
    issue(identity) {
      counter += 1;
      const code = `code-${counter}`;
      codes.set(code, identity);
      return code;
    },
    async fetch(url, opts) {
      const parsed = new URL(url);
      // Pinned: the allowlist is exactly the host being called, nothing broader.
      if (opts.allowHosts.length !== 1 || opts.allowHosts[0] !== parsed.hostname) {
        throw new Error(`fake oauth: ${url} called with allowHosts ${opts.allowHosts.join(',')}`);
      }
      if (opts.allowPublic === true) throw new Error('fake oauth: allowPublic used');
      // The C-1 carve-out names exactly the URL called, and only for the LinkedIn endpoints.
      const official = url === LINKEDIN_TOKEN || url === LINKEDIN_USERINFO;
      if (opts.officialApiUrl !== (official ? url : undefined)) {
        throw new Error(`fake oauth: ${url} called with officialApiUrl ${opts.officialApiUrl}`);
      }
      const call: FakeCall = { url, opts };
      calls.push(call);
      if (TOKEN_URLS.has(url)) {
        if (opts.post === undefined) throw new Error('fake oauth: token GET');
        const form = new URLSearchParams(opts.post.body);
        call.form = form;
        if (fake.tokenStatus !== null) {
          return json(fake.tokenStatus, { error: 'server_error' }, url);
        }
        if (form.get('client_secret') !== 'client-secret-value') {
          return json(401, { error: 'invalid_client' }, url);
        }
        const identity = codes.get(form.get('code') ?? '');
        if (identity === undefined) return json(400, { error: 'invalid_grant' }, url);
        // A code is single use at the provider.
        codes.delete(form.get('code') ?? '');
        counter += 1;
        const accessToken = `at-${counter}`;
        tokens.set(accessToken, identity);
        return json(200, { access_token: accessToken, token_type: 'bearer' }, url);
      }
      const auth = opts.headers?.authorization ?? '';
      const identity = tokens.get(auth.replace(/^Bearer /, ''));
      if (identity === undefined) return json(401, { message: 'Bad credentials' }, url);
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo' || url === LINKEDIN_USERINFO) {
        return json(
          200,
          {
            sub: identity.id,
            ...(identity.email === null
              ? {}
              : { email: identity.email, email_verified: identity.emailVerified }),
            name: identity.name ?? 'Google User',
          },
          url,
        );
      }
      if (url === 'https://api.github.com/user') {
        return json(
          200,
          {
            id: Number(identity.id),
            login: 'octo',
            name: identity.name ?? null,
            // GitHub's public profile email is never trusted for verification.
            email: identity.email,
          },
          url,
        );
      }
      if (url === 'https://api.github.com/user/emails') {
        return json(
          200,
          identity.email === null
            ? []
            : [
                { email: 'secondary@example.net', primary: false, verified: true },
                { email: identity.email, primary: true, verified: identity.emailVerified },
              ],
          url,
        );
      }
      return json(404, { error: 'not_found' }, url);
    },
  };
  return fake;
}
