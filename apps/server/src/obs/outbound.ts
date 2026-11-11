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
import { FIXED_SERVICE_HOSTS, HTTP_METHODS, OTHER, type OutboundTarget } from './catalog';
import { isCollecting, isSuppressed, obs } from './index';

export interface OutboundCall {
  target: OutboundTarget;
  /** The request's method as the caller sends it. */
  method: string;
  /** The request's URL: read for its host only, to name a fixed public service. */
  url: string | URL;
}

const METHODS = new Set<string>(HTTP_METHODS);
const FIXED_HOSTS = new Set<string>(FIXED_SERVICE_HOSTS);
const CODE = /^[A-Za-z0-9_.-]{1,64}$/;

function method(m: string): string {
  const upper = m.toUpperCase();
  return METHODS.has(upper) ? upper : OTHER;
}

/** The host when it is a fixed public service, else nothing (14.8). */
function fixedHost(url: string | URL): string | undefined {
  try {
    const host = (url instanceof URL ? url : new URL(url)).hostname.toLowerCase();
    return FIXED_HOSTS.has(host) ? host : undefined;
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
export async function observeOutbound(
  call: OutboundCall,
  send: () => Promise<Response>,
): Promise<Response> {
  if (!isCollecting() || isSuppressed()) return send();
  const base: Record<string, unknown> = {
    'http.request.method': method(call.method),
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

/** `fetchImpl` with every request observed under one target (the AI providers' fetch, MCP). */
export function observedFetch(target: OutboundTarget, fetchImpl: typeof fetch): typeof fetch {
  return (input, init) => {
    const url = input instanceof Request ? input.url : input;
    const m = init?.method ?? (input instanceof Request ? input.method : 'GET');
    return observeOutbound({ target, method: m, url }, () => fetchImpl(input, init));
  };
}
