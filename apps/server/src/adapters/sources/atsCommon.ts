// Shared plumbing for the ATS adapters (Greenhouse, Lever, Ashby). Each adapter fetches one
// public, unauthenticated board API through sctx.fetch (safeFetch) with exactly its own API host
// allowed. Values are passed on raw: the engine sanitizes every posting before storing it, so the
// helpers here only pick fields out of untyped JSON without trusting their types.
import { AtsConfig, SourceConfigError, type SourceContext } from '../discoverySource';

/** Board responses can be large (Greenhouse with content=true); still bounded. */
export const ATS_MAX_BYTES = 25 * 1024 * 1024;
export const ATS_TIMEOUT_MS = 30_000;

/** The org slug from a source config; an invalid config cannot be fixed by retrying. */
export function atsOrg(config: unknown): string {
  const parsed = AtsConfig.safeParse(config);
  if (!parsed.success) throw new SourceConfigError('invalid ATS config: org must be a board slug');
  return parsed.data.org;
}

/**
 * GETs a board API URL and parses its JSON. 404 means the provider has no such org (a
 * SourceConfigError); any other non-2xx or unparseable body is an ordinary, retryable error.
 */
export async function fetchBoardJson(
  sctx: SourceContext,
  url: string,
  host: string,
  label: string,
  org: string,
): Promise<unknown> {
  const res = await sctx.fetch(url, {
    allowHosts: [host],
    maxBytes: ATS_MAX_BYTES,
    timeoutMs: ATS_TIMEOUT_MS,
  });
  if (res.status === 404) throw new SourceConfigError(`${label} has no board for org ${org}`);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${label} board ${org} answered HTTP ${res.status}`);
  }
  try {
    return JSON.parse(res.body.toString('utf8')) as unknown;
  } catch {
    throw new Error(`${label} board ${org} returned invalid JSON`);
  }
}

/** A plain object, else an empty one. */
export function obj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** A non-empty string (numbers are stringified, e.g. numeric ids), else null. */
export function str(v: unknown): string | null {
  if (typeof v === 'string') return v.length > 0 ? v : null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** Epoch ms from an ISO string or a number; null when unparseable. */
export function timeMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/** "Remote", "Remote - US", "Anywhere (remote)" read as remote; anything else is unknown. */
export function remoteFromLocation(location: string | null): boolean | null {
  return location !== null && /\bremote\b/i.test(location) ? true : null;
}
