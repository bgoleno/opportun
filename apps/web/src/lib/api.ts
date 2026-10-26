// Thin JSON client for /api/v1. Sends the double-submit CSRF header on unsafe methods,
// unwraps the server's {error} envelope into ApiError, and sends 401s to /login.

export const API_BASE = '/api/v1';
export const CSRF_COOKIE = 'opportun_csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface ApiIssue {
  path: (string | number)[];
  code: string;
  message: string;
}

export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  readonly code: string;
  readonly issues: ApiIssue[] | undefined;
  /** Extra envelope fields, e.g. existingId on a 409 duplicate. */
  readonly details: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message?: string,
    issues?: ApiIssue[],
    details: Record<string, unknown> = {},
  ) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.issues = issues;
    this.details = details;
  }
}

/** Reads a cookie value by name (the CSRF cookie is deliberately not HttpOnly). */
export function readCookie(name: string): string | undefined {
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

type UnauthorizedHandler = () => void;

let onUnauthorized: UnauthorizedHandler = () => {
  const here = window.location.pathname;
  if (here !== '/login' && here !== '/register') {
    window.location.assign(`/login?redirect=${encodeURIComponent(here + window.location.search)}`);
  }
};

/** Replaces the 401 behaviour (the app wires this to a router navigation). */
export function setUnauthorizedHandler(fn: UnauthorizedHandler): void {
  onUnauthorized = fn;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Calls `${API_BASE}${path}`. Resolves with the parsed JSON body (undefined for 204).
 * A FormData body is sent as multipart; anything else is sent as JSON.
 * Throws ApiError for any non-2xx response. A 401 outside /auth/* also triggers the
 * unauthorized handler, which by default navigates to /login.
 */
export async function api<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> {
  const method = (opts?.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: string | FormData | undefined;
  if (opts?.body instanceof FormData) {
    // Multipart: the browser sets content-type with the boundary.
    body = opts.body;
  } else if (opts?.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  if (!SAFE_METHODS.has(method)) {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf !== undefined) headers['x-csrf-token'] = csrf;
  }

  // A `keepalive` fetch survives the page navigating away mid-flight (#124): without it, a
  // small, time-sensitive mutation (a stage change, a toggle) can be silently dropped by the
  // browser if the person clicks away right after confirming, before the response arrives.
  // Scoped to small JSON bodies: the keepalive budget is a combined 64KB across every
  // in-flight keepalive request on the page, so a large body (a long description, a multipart
  // upload) is excluded rather than risk that cap silently failing a save.
  const KEEPALIVE_MAX_BYTES = 16_384;
  const keepalive = typeof body === 'string' && new Blob([body]).size <= KEEPALIVE_MAX_BYTES;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    keepalive,
    ...(body === undefined ? {} : { body }),
  });

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = undefined;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }

  if (!res.ok) {
    const envelope = isRecord(data) && isRecord(data.error) ? data.error : {};
    const { code, message, issues, ...details } = envelope;
    const err = new ApiError(
      res.status,
      typeof code === 'string' ? code : `http_${res.status}`,
      typeof message === 'string' ? message : undefined,
      Array.isArray(issues) ? (issues as ApiIssue[]) : undefined,
      details,
    );
    // Auth endpoints answer 401 for bad credentials or "not signed in yet": the caller decides.
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized();
    throw err;
  }
  return data as T;
}

/** A short human message for an error thrown by api(). */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'validation':
        return err.issues?.[0]?.message ?? 'Some fields are invalid.';
      case 'duplicate':
        return 'That already exists.';
      case 'csrf':
        return 'Your session token is missing or stale. Reload the page and try again.';
      case 'rate_limited':
        return 'Too many attempts. Wait a few minutes and try again.';
      case 'unauthorized':
        return 'You are signed out.';
      case 'not_found':
        return 'Not found.';
      case 'payload_too_large':
        return 'That file is too large.';
      default:
        return err.message === err.code ? `Request failed (${err.code}).` : err.message;
    }
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}
