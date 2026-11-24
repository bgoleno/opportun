// Where a sign-in goes on to: the page that was asked for while signed out, which the sign-in page has as
// `?redirect=` (https://github.com/bgoleno/opportun/issues/942). It is kept over a trip to a sign-in
// provider in this tab's sessionStorage, and never by the server, so no request can name where the server
// redirects to. Nothing but this file reads it, and it is gone to as signInTarget gives it, by the router
// alone: whoever goes there has only what has been checked.
import type { AnyRouter } from '@tanstack/react-router';
import { dropReason } from './oauth';

/** Of an address, as long as a page of the app is ever asked for with. */
const TARGET_MAX = 2000;
/** How often an address is decoded, for what it is to whoever decodes it again; more is refused. */
const DECODE_MAX = 5;
/** Any origin: an address is resolved against it, and is refused unless it stays there. */
const BASE = 'https://opportun.invalid';
/**
 * Control characters (browsers strip tab, CR and LF from URLs, so "/\t/evil" becomes "//evil") and
 * backslashes (treated as "/" by browsers) are never part of a safe target.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_REDIRECT_CHARS = /[\u0000-\u001f\\]/;
/** First segments that are no page to go on to: signing in, and what the server answers itself. */
const NOT_A_PAGE = new Set([
  'login',
  'register',
  'api',
  'healthz',
  'assets',
  'favicon.svg',
  'theme-init.js',
]);

/** The path decoded until decoding it changes nothing; undefined when it can't be, or not soon. */
function fullyDecoded(path: string): string | undefined {
  let text = path;
  for (let i = 0; i < DECODE_MAX; i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(text);
    } catch {
      return undefined;
    }
    if (next === text) return text;
    text = next;
  }
  return undefined;
}

function resolved(target: string): URL | undefined {
  try {
    const url = new URL(target, BASE);
    return url.origin === BASE && !url.pathname.startsWith('//') ? url : undefined;
  } catch {
    return undefined;
  }
}

/** The page `target` names, as it resolves, or undefined when it is not one of the app's own. */
function pageOf(target: unknown): string | undefined {
  if (typeof target !== 'string' || target.length > TARGET_MAX) return undefined;
  if (UNSAFE_REDIRECT_CHARS.test(target)) return undefined;
  if (!target.startsWith('/') || target.startsWith('//')) return undefined;
  const url = resolved(target);
  if (url === undefined) return undefined;
  const decoded = fullyDecoded(url.pathname);
  if (decoded === undefined || UNSAFE_REDIRECT_CHARS.test(decoded)) return undefined;
  // What a path that was encoded says once decoded can be another site's, or resolve to another path.
  const page = resolved(decoded);
  if (page === undefined) return undefined;
  const first = page.pathname.split('/')[1] ?? '';
  if (NOT_A_PAGE.has(first.toLowerCase())) return undefined;
  return url.pathname + url.search + url.hash;
}

/** Only a page of the app is honoured as a post-login redirect; anything else is the Dashboard. */
export function safeRedirect(target: unknown): string {
  return pageOf(target) ?? '/';
}

/** The one way a redirect is gone to: checked, as it resolves, in place of the page it is asked on. */
function signInTarget(target: unknown): { href: string; replace: true } {
  return { href: safeRedirect(target), replace: true };
}

// ---------------------------------------------------------------------------
// Kept over a provider's round trip

const KEY = 'opportun.loginRedirect';
/** The life of a provider's round trip (the server's OAUTH_STATE_TTL_MS). */
export const KEPT_MS = 10 * 60 * 1000;

const Kept = {
  write(to: string): void {
    try {
      window.sessionStorage.setItem(KEY, JSON.stringify({ to, at: Date.now() }));
    } catch {
      // No storage (a private window, a full one): the sign-in goes to the Dashboard.
    }
  },
  drop(): void {
    try {
      window.sessionStorage.removeItem(KEY);
    } catch {
      // As above.
    }
  },
  /** The page kept, checked again; whatever else is there is removed. */
  read(): string | undefined {
    try {
      const text = window.sessionStorage.getItem(KEY);
      if (text === null) return undefined;
      const { to, at } = JSON.parse(text) as { to?: unknown; at?: unknown };
      const age = typeof at === 'number' && Number.isFinite(at) ? Date.now() - at : -1;
      const page = age >= 0 && age <= KEPT_MS ? pageOf(to) : undefined;
      if (page === undefined) Kept.drop();
      return page;
    } catch {
      Kept.drop();
      return undefined;
    }
  },
};

/** Nothing is kept any more: a sign-in has been made, or ended. */
export const dropKeptRedirect = (): void => Kept.drop();

function searchOf(router: AnyRouter): Record<string, unknown> {
  return router.state.location.search as Record<string, unknown>;
}

/** Signed in: on to the page that was asked for. */
export async function goAfterSignIn(router: AnyRouter): Promise<void> {
  Kept.drop();
  await router.navigate(signInTarget(searchOf(router).redirect));
}

/** "Continue with ..." was pressed: the page that was asked for is kept until the provider answers. */
export function keepForProvider(router: AnyRouter): void {
  const page = pageOf(searchOf(router).redirect);
  if (page === undefined) Kept.drop();
  else Kept.write(page);
}

/**
 * The sign-in page was landed on: the reason it was sent with is taken out of the address, which the
 * page has read by now, so that a reload or Back does not say it again; and where a provider's refusal
 * brought it back without the page that was asked for, that is put there again.
 */
export function settleLoginAddress(router: AnyRouter): void {
  const kept = searchOf(router).redirect === undefined ? Kept.read() : undefined;
  // Its hash is a sign-in's second step, which has been taken.
  dropReason(router, {
    ...(kept === undefined ? {} : { add: { redirect: kept } }),
    keepHash: false,
  });
}

let loaded = false;
/**
 * At the app's first load (a provider's return is always a whole page load), the page to go on to from
 * `/`, signed in. Anywhere but the sign-in page, what was kept is done with at that load, used or not.
 */
export function takeAtFirstLoad(
  pathname: string,
  signedIn: boolean,
): { href: string; replace: true } | undefined {
  if (loaded) return undefined;
  loaded = true;
  if (/^\/login\/?$/i.test(pathname)) return undefined;
  const page = Kept.read();
  Kept.drop();
  return signedIn && pathname === '/' && page !== undefined ? signInTarget(page) : undefined;
}
