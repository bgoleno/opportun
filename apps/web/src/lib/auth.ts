// Session state for the SPA. The session cookie is HttpOnly, so "who am I" always comes
// from GET /auth/me; a 401 there means signed out (null), not an error.
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api, ApiError, CSRF_COOKIE, readCookie } from './api';

export interface User {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
}

export const meQuery = queryOptions({
  queryKey: ['auth', 'me'] as const,
  queryFn: async (): Promise<User | null> => {
    // The CSRF cookie is issued and cleared with the session: without it there is no
    // session to ask about (and no 401 to log in the console).
    if (readCookie(CSRF_COOKIE) === undefined) return null;
    try {
      return (await api<{ user: User }>('/auth/me')).user;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
  },
  staleTime: 5 * 60 * 1000,
  retry: false,
});

/**
 * Whether a visitor could register right now: unauthenticated on purpose, and not a new
 * exposure, since POST /auth/register is itself unauthenticated and already reveals this via
 * its 403 registration_closed. Used by the signed-out login page to decide whether offering
 * the link to /register would be truthful (first-run bootstrapping) rather than a dead end
 * (the invitation-only demo, every other closed instance).
 */
export const registrationOpenQuery = queryOptions({
  queryKey: ['auth', 'registrationOpen'] as const,
  queryFn: async () => (await api<{ open: boolean }>('/auth/registration')).open,
  staleTime: 60 * 1000,
  retry: false,
});

export const PASSWORD_MIN = 12;

export const LoginSchema = z.object({
  email: z.string().trim().min(1, 'Enter your email').max(254),
  password: z.string().min(1, 'Enter your password').max(1024),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const RegisterSchema = z
  .object({
    displayName: z.string().trim().min(1, 'Enter your name').max(100),
    email: z.string().trim().pipe(z.email('Enter a valid email').max(254)),
    password: z.string().min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`).max(1024),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    path: ['confirm'],
    message: 'Passwords do not match',
  });
export type RegisterInput = z.infer<typeof RegisterSchema>;

/** A password sign-in either completes, or (2FA on) asks for a code with a pending token. */
export type LoginResult =
  { kind: 'signedIn'; user: User } | { kind: 'twoFactor'; pendingToken: string };

export async function login(qc: QueryClient, input: LoginInput): Promise<LoginResult> {
  const res = await api<{ user: User } | { requires2fa: true; pendingToken: string }>(
    '/auth/login',
    { method: 'POST', body: input },
  );
  if ('requires2fa' in res) return { kind: 'twoFactor', pendingToken: res.pendingToken };
  qc.setQueryData(meQuery.queryKey, res.user);
  return { kind: 'signedIn', user: res.user };
}

/** The second sign-in step: the pending token plus a TOTP code or a recovery code. */
export async function verifyTwoFactor(
  qc: QueryClient,
  input: { pendingToken: string } & ({ code: string } | { recoveryCode: string }),
): Promise<User> {
  const { user } = await api<{ user: User }>('/auth/2fa/verify', { method: 'POST', body: input });
  qc.setQueryData(meQuery.queryKey, user);
  return user;
}

/** Six digits, with spaces a user might paste ("123 456") removed. */
export const TotpCodeSchema = z
  .string()
  .transform((v) => v.replace(/\s+/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app'));
export const RecoveryCodeSchema = z
  .string()
  .trim()
  .min(1, 'Enter one of your recovery codes')
  .max(64);

export async function register(qc: QueryClient, input: RegisterInput): Promise<User> {
  const { user } = await api<{ user: User }>('/auth/register', {
    method: 'POST',
    body: { displayName: input.displayName, email: input.email, password: input.password },
  });
  qc.setQueryData(meQuery.queryKey, user);
  return user;
}

/**
 * Clearing the cache before knowing whether `POST /auth/logout` succeeded would show
 * signed-out for a logout that did not happen (#151, design.md principle 6): on a shared
 * device, the session stays live on the server and a reload can sign the next person back
 * into it, right after a screen told them it was safe to walk away. The cache is cleared only
 * once the server has actually confirmed the session ended; a failure propagates instead,
 * still signed in, for the caller to show honestly and offer `forceLocalSignOut` as the
 * deliberate, named exception below.
 */
export async function logout(qc: QueryClient): Promise<void> {
  await api('/auth/logout', { method: 'POST' });
  qc.clear();
  qc.setQueryData(meQuery.queryKey, null);
}

/**
 * The escape hatch for a `logout` that could not be confirmed (#151): clears what this
 * browser believes about its own session without the server's confirmation that the session
 * actually ended. The session cookie is HttpOnly, so this cannot touch it either way; this is
 * for a person who cannot wait out a retry right now, not a safe substitute for one. The
 * caller must tell them, in those terms, before calling this, not after.
 */
export function forceLocalSignOut(qc: QueryClient): void {
  qc.clear();
  qc.setQueryData(meQuery.queryKey, null);
}

/**
 * Control characters (browsers strip tab, CR and LF from URLs, so "/\t/evil" becomes
 * "//evil") and backslashes (treated as "/" by browsers) are never part of a safe target.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_REDIRECT_CHARS = /[\u0000-\u001f\\]/;

/** Only same-origin absolute paths are honoured as post-login redirects. */
export function safeRedirect(target: unknown): string {
  if (typeof target !== 'string') return '/';
  if (UNSAFE_REDIRECT_CHARS.test(target)) return '/';
  if (!target.startsWith('/') || target.startsWith('//') || target.startsWith('/\\')) return '/';
  if (target.startsWith('/login') || target.startsWith('/register')) return '/';
  return target;
}

export const PUBLIC_PATHS = new Set(['/login', '/register']);
