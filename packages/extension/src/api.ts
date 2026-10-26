// The extension's one network call: POST <server>/api/v1/connector/capture on the user's own
// Opportun server, bearer device token (capture:push). Classifies every response into an
// Outcome the popup renders. fetch is injected; unit-tested.
import type { CapturePayload } from './normalize';
import { captureEndpoint, type Settings } from './settings';

export interface FetchInit {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  credentials: 'omit';
  redirect: 'error';
}

export interface FetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

export type Outcome =
  // What the server created (apps/server/src/routes/connectorCapture.ts response shapes).
  | { kind: 'profile'; contactId: string; created: boolean; refined: boolean }
  | {
      kind: 'job';
      resultId: string | null;
      duplicate: boolean;
      refined: boolean;
      /** Added 2026-10-19; absent from a server older than this extension. */
      opportunityId?: string;
      /** The stage the capture moved it to, null when the stage was left alone. */
      stage?: string | null;
    }
  | { kind: 'connected' }
  // What the server refused.
  | { kind: 'refused'; reason: string }
  | { kind: 'unauthorized' }
  | { kind: 'forbidden' }
  | { kind: 'rate_limited'; retryAfterSec: number | null }
  | { kind: 'too_large' }
  | { kind: 'invalid'; status: number; code: string }
  | { kind: 'server_error'; status: number }
  | { kind: 'network' }
  // Stopped in the popup before anything was sent.
  | { kind: 'no_settings' }
  | { kind: 'not_linkedin' }
  | { kind: 'empty_page' }
  | { kind: 'permission_denied' }
  | { kind: 'inject_failed' };

/**
 * A page the server is certain to refuse (422 unrecognized_page, reason unsupported_path)
 * after it has authenticated the token: the connection test creates nothing. It does spend
 * one capture from the token's budget.
 */
export const CONNECTION_TEST_PAYLOAD: CapturePayload = {
  url: 'https://www.linkedin.com/opportun-connection-test/',
  title: 'Opportun connection test',
  text: 'Opportun connection test: not a profile or a job page.',
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

async function readJson(res: FetchResponse): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function errorOf(body: unknown): Record<string, unknown> {
  return isRecord(body) && isRecord(body.error) ? body.error : {};
}

function success(status: number, body: unknown): Outcome {
  if (isRecord(body) && typeof body.refined === 'boolean') {
    if (
      body.kind === 'profile' &&
      typeof body.contactId === 'string' &&
      typeof body.created === 'boolean'
    ) {
      return {
        kind: 'profile',
        contactId: body.contactId,
        created: body.created,
        refined: body.refined,
      };
    }
    if (
      body.kind === 'job' &&
      (typeof body.resultId === 'string' || body.resultId === null) &&
      typeof body.duplicate === 'boolean'
    ) {
      // The four original fields are the frozen contract; the two below were added later and
      // are carried through only when the server actually sent them, so this build reads an
      // older server without falling over.
      return {
        kind: 'job',
        resultId: body.resultId,
        duplicate: body.duplicate,
        refined: body.refined,
        ...(typeof body.opportunityId === 'string' ? { opportunityId: body.opportunityId } : {}),
        ...(typeof body.stage === 'string' || body.stage === null ? { stage: body.stage } : {}),
      };
    }
  }
  return { kind: 'server_error', status };
}

async function classify(res: FetchResponse): Promise<Outcome> {
  const { status } = res;
  const body = await readJson(res);
  if (status === 200 || status === 201) return success(status, body);
  if (status === 401) return { kind: 'unauthorized' };
  if (status === 403) return { kind: 'forbidden' };
  if (status === 413) return { kind: 'too_large' };
  if (status === 429) {
    const after = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
    return { kind: 'rate_limited', retryAfterSec: Number.isFinite(after) ? after : null };
  }
  const error = errorOf(body);
  const code = typeof error.code === 'string' ? error.code : 'unknown';
  if (status === 422 && code === 'unrecognized_page') {
    return { kind: 'refused', reason: typeof error.reason === 'string' ? error.reason : 'unknown' };
  }
  if (status >= 400 && status < 500) return { kind: 'invalid', status, code };
  return { kind: 'server_error', status };
}

async function send(fetch: FetchLike, settings: Settings, payload: CapturePayload) {
  try {
    return await fetch(captureEndpoint(settings.serverUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${settings.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      // Bearer only: never send this browser's cookies for the server, and never let a
      // redirect carry the request (and its token) somewhere else.
      credentials: 'omit',
      redirect: 'error',
    });
  } catch {
    return null;
  }
}

export async function postCapture(
  fetch: FetchLike,
  settings: Settings,
  payload: CapturePayload,
): Promise<Outcome> {
  const res = await send(fetch, settings, payload);
  return res === null ? { kind: 'network' } : classify(res);
}

export async function testConnection(fetch: FetchLike, settings: Settings): Promise<Outcome> {
  const res = await send(fetch, settings, CONNECTION_TEST_PAYLOAD);
  if (res === null) return { kind: 'network' };
  const outcome = await classify(res);
  if (outcome.kind === 'refused') return { kind: 'connected' };
  // The test page must never be accepted: whatever answered is not the expected server.
  if (outcome.kind === 'profile' || outcome.kind === 'job') {
    return { kind: 'server_error', status: res.status };
  }
  return outcome;
}
