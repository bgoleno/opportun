// The observed outbound request (design.md 14.2, 14.4, 14.8; issue
// https://github.com/bgoleno/opportun/issues/353). FR-T3 puts it inside safeFetch, around the AI
// providers' fetch, MCP and the Google API seam; this file is the wrapper they call.
//
// It only watches. The request goes out exactly as the caller built it: no header is added (no
// `traceparent`: nothing crosses the process boundary, 14.6), the URL, body and options are
// passed through untouched, redirects and timeouts stay the caller's, and the response is
// returned as it came, its body unread. What it records is the time to the response, the
// method, a named target from a closed list, the status code and an error class:
//
// - never the URL, its path or query, and never a header or a body;
// - `server.address` only when the host is one of the fixed public services the catalog lists
//   (a provider's API, an ATS board, Google). A host the user configured or a page they
//   captured gets its target only (14.8);
// - for a thrown error, its class or code (`TypeError`, `AbortError`, `ECONNREFUSED`), never its
//   message, which can quote the URL.
//
// With collection off, or inside the exporter's own requests (runSuppressed), it calls straight
// through after one check.
import { fixedServiceHosts, HTTP_METHODS, OTHER, type OutboundTarget } from './catalog';
import { isCollecting, isSuppressed, obs } from './index';

export interface OutboundCall {
  target: OutboundTarget;
  /** The request's method as the caller sends it. */
  method: string;
  /** The request's URL: read for its host only, to name a fixed public service. */
  url: string | URL;
}

// Read on first use, never at load: safeFetch imports this file and the catalog imports
// safeFetch, so whichever loads first may find the other still initialising (#343).
let methods: ReadonlySet<string> | undefined;
let fixedHosts: ReadonlySet<string> | undefined;
const isFixedHost = (host: string): boolean =>
  (fixedHosts ??= new Set(fixedServiceHosts())).has(host);
const CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/** A request's method as the HTTP conventions list it, else OTHER. */
export function httpMethod(m: string): string {
  const upper = m.toUpperCase();
  return (methods ??= new Set<string>(HTTP_METHODS)).has(upper) ? upper : OTHER;
}

/** The host when it is a fixed public service, else nothing (14.8). */
function fixedHost(url: string | URL): string | undefined {
  try {
    const host = (url instanceof URL ? url : new URL(url)).hostname.toLowerCase();
    return isFixedHost(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

/** A thrown error's class or code, never its message. */
export function errorType(err: unknown): string {
  if (err instanceof Error) {
    const code =
      (err as { code?: unknown }).code ?? (err.cause as { code?: unknown } | undefined)?.code;
    if (typeof code === 'string' && CODE.test(code)) return code;
    return CODE.test(err.name) ? err.name : 'Error';
  }
  return 'Error';
}

/**
 * Runs one outbound request through `send` and records it: the http.client.request.duration
 * metric, and a CLIENT span named by its method. `send` is the caller's own request.
 */
export async function observeOutbound<R extends { status: number }>(
  call: OutboundCall,
  send: () => Promise<R>,
): Promise<R> {
  if (!isCollecting() || isSuppressed()) return send();
  const base: Record<string, unknown> = {
    'http.request.method': httpMethod(call.method),
    'opportun.outbound.target': call.target,
  };
  const host = fixedHost(call.url);
  if (host !== undefined) base['server.address'] = host;
  return obs.span('http.client', base, async (span) => {
    const started = performance.now();
    try {
      const res = await send();
      const status: Record<string, unknown> = { 'http.response.status_code': res.status };
      // The HTTP conventions' error.type for a 4xx or 5xx response is its status code.
      if (res.status >= 400) status['error.type'] = String(res.status);
      span.set(status);
      obs.record('http.client.request.duration', (performance.now() - started) / 1000, {
        ...base,
        ...status,
      });
      return res;
    } catch (err) {
      const type = errorType(err);
      span.fail(type);
      obs.record('http.client.request.duration', (performance.now() - started) / 1000, {
        ...base,
        'error.type': type,
      });
      throw err;
    }
  });
}

/**
 * A call through a client library that hides its HTTP (the Google API seam, lib/google.ts):
 * recorded like a request, under `method` as the library sends it. A success has no status the
 * caller can see, so none is recorded; a failure records the library error's HTTP status
 * (`status`, or `response.status`) as status and error.type, else its code or class.
 */
export async function observeCall<T>(
  call: { target: OutboundTarget; method: string },
  run: () => Promise<T>,
): Promise<T> {
  if (!isCollecting() || isSuppressed()) return run();
  const base = {
    'http.request.method': httpMethod(call.method),
    'opportun.outbound.target': call.target,
  };
  return obs.span('http.client', base, async (span) => {
    const started = performance.now();
    try {
      const value = await run();
      obs.record('http.client.request.duration', (performance.now() - started) / 1000, base);
      return value;
    } catch (err) {
      const status = statusOf(err);
      const failure = status === undefined ? errorType(err) : String(status);
      const attributes = {
        ...base,
        ...(status === undefined ? {} : { 'http.response.status_code': status }),
        'error.type': failure,
      };
      span.set(attributes);
      span.fail(failure);
      obs.record('http.client.request.duration', (performance.now() - started) / 1000, attributes);
      throw err;
    }
  });
}

/** An HTTP status a client library's error carries (gaxios: `status`, `response.status`). */
function statusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { status?: unknown; response?: { status?: unknown } };
  const status = e.status ?? e.response?.status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status < 600
    ? status
    : undefined;
}

/**
 * The target of a safeFetch request (tl on #343): the caller's own when it names one, else
 * from a literal host map. Never a suffix match on a host a user could configure, except the
 * one Workday wildcard (a tenant's board lives on its own subdomain). This picks the target
 * only: server.address still comes from the catalog's fixed list alone, so a tenant's host
 * never appears.
 */
export function outboundTargetFor(req: {
  url: URL;
  target?: OutboundTarget;
  officialApiUrl?: string;
}): OutboundTarget {
  if (req.target !== undefined) return req.target;
  if (req.officialApiUrl !== undefined) return 'oauth';
  const host = req.url.hostname.toLowerCase().replace(/\.$/, '');
  const known = TARGET_BY_HOST.get(host);
  if (known !== undefined) return known;
  if (host.endsWith(WORKDAY_SUFFIX) && host.length > WORKDAY_SUFFIX.length) return 'ats_workday';
  return 'public_site';
}

const WORKDAY_SUFFIX = '.myworkdayjobs.com';

const TARGET_BY_HOST = new Map<string, OutboundTarget>([
  ['boards-api.greenhouse.io', 'ats_greenhouse'],
  ['api.lever.co', 'ats_lever'],
  ['api.ashbyhq.com', 'ats_ashby'],
  ['api.smartrecruiters.com', 'ats_smartrecruiters'],
  ['apply.workable.com', 'ats_workable'],
  ['accounts.google.com', 'google'],
  ['oauth2.googleapis.com', 'google'],
  ['openidconnect.googleapis.com', 'google'],
  ['www.googleapis.com', 'google'],
  ['gmail.googleapis.com', 'google'],
  ['docs.googleapis.com', 'google'],
]);

/** `fetchImpl` with every request observed under one target (the AI providers' fetch, MCP). */
export function observedFetch(target: OutboundTarget, fetchImpl: typeof fetch): typeof fetch {
  return (input, init) => {
    const url = input instanceof Request ? input.url : input;
    const m = init?.method ?? (input instanceof Request ? input.method : 'GET');
    return observeOutbound({ target, method: m, url }, () => fetchImpl(input, init));
  };
}
