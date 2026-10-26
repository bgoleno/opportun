// OAuth sign-in (FR-S4) for the SPA: provider names, the server-side start URLs (plain
// navigations, since the server answers with a redirect to the provider), and the flashes
// the callback sends back.
import { queryOptions } from '@tanstack/react-query';
import { api, API_BASE } from './api';

export const OAUTH_PROVIDERS = ['google', 'github', 'linkedin'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export function providerLabel(provider: OAuthProvider): string {
  switch (provider) {
    case 'google':
      return 'Google';
    case 'github':
      return 'GitHub';
    case 'linkedin':
      return 'LinkedIn';
  }
}

/** The providers an admin configured: public, so the login page can ask. */
export const oauthProvidersQuery = queryOptions({
  queryKey: ['auth', 'oauth', 'providers'] as const,
  queryFn: async () =>
    (await api<{ providers: OAuthProvider[] }>('/auth/oauth/providers')).providers,
  staleTime: 5 * 60 * 1000,
});

/** Sign-in only: linking is a password-confirmed POST (Settings > Security). */
export function oauthStartHref(provider: OAuthProvider): string {
  return `${API_BASE}/auth/oauth/${provider}/start?mode=login`;
}

const LOGIN_FLASH = new Map<string, string>([
  [
    'unknown',
    'No account here matches that sign-in. If you already have one, sign in with your password and link the provider under Settings > Security.',
  ],
  [
    'existing_account',
    'This email already has an account here. To use this provider, sign in with your password, then link it under Settings > Security.',
  ],
  ['denied', 'Sign-in was cancelled at the provider.'],
  ['session', 'Your session ended before linking finished. Sign in and try again.'],
]);
const GENERIC_ERROR = 'Something went wrong signing in with that provider. Try again.';

/** The login page message for ?oauth=..., or null when there is none. */
export function oauthFlashMessage(flash: string | undefined): string | null {
  if (flash === undefined || flash === '') return null;
  return LOGIN_FLASH.get(flash) ?? GENERIC_ERROR;
}

const PENDING_FRAGMENT = /^#pending2fa=([A-Za-z0-9_-]{16,128})$/;

/**
 * An OAuth sign-in for an account with two-factor on lands on /login#pending2fa=<token>. The
 * token is read once and removed from the address bar (and so from history).
 */
export function takePendingFromHash(): string | null {
  const match = PENDING_FRAGMENT.exec(window.location.hash);
  if (match === null) return null;
  window.history.replaceState(
    window.history.state,
    '',
    window.location.pathname + window.location.search,
  );
  return match[1] ?? null;
}
