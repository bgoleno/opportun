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
  /** The request is finished though the popup that sent it is closed. */
  keepalive?: true;
  /** Ends the request at the action's time limit (#648). */
  signal?: AbortSignal;
}

export interface FetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  /** The resume copy's bytes (assisted apply, prefill.ts); every real fetch Response has it. */
  arrayBuffer?(): Promise<ArrayBuffer>;
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
      /** Whether this capture made the opportunity, and the stage it is at (#967). All five below are
       *  absent from an older server. */
      created?: boolean;
      currentStage?: string;
      /** The captured description: added to an opportunity that was there, or its own kept. */
      description?: 'added' | 'kept';
      /** How many other postings on the card it completed went with it. */
      linked?: number;
      /** Sent only when what the opportunity lacked was not added (#914); absent otherwise. */
      filled?: false;
      /** It joined the opportunity as another posting of its role (#1037); absent otherwise. */
      anotherPosting?: true;
    }
  | { kind: 'connected' }
  // What the server refused.
  | { kind: 'refused'; reason: string }
  | { kind: 'unauthorized' }
  | { kind: 'forbidden' }
  | { kind: 'rate_limited'; retryAfterSec: number | null; limit?: CaptureLimit }
  /** Another capture of the user's was being saved, and this one could not wait (#309). */
  | { kind: 'busy'; retryAfterSec: number | null }
  | { kind: 'too_large' }
  | { kind: 'invalid'; status: number; code: string }
  | { kind: 'server_error'; status: number }
  | { kind: 'network' }
  // Stopped in the popup before anything was sent.
  | { kind: 'no_settings' }
  /** The tab is not on a capture site: it was not read. */
  | { kind: 'unsupported_tab' }
  /** An address of a capture site that is not read: `host` is the one that is. Not read, not sent. */
  | { kind: 'other_address'; host: string }
  /** An Indeed tab that shows no single posting (no valid job key): not read, nothing sent. */
  | { kind: 'not_a_posting' }
  /** The Indeed job's markup was not recognized: refused in the tab, nothing sent. */
  | { kind: 'layout_unrecognized' }
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

/**
 * Which capture limit a 429 hit, as the server names it (#272): the user's own, shared by every
 * browser and the web app, or this token's. Absent from an older server, or when the body does
 * not hold plain counts, and the popup then says what it said before.
 */
export interface CaptureLimit {
  per: 'user' | 'token';
  max: number;
  windowMinutes: number;
}

const PER: Readonly<Record<string, CaptureLimit['per']>> = { per_user: 'user', per_token: 'token' };

const isCount = (v: unknown, most: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= most;

function limitOf(error: Record<string, unknown>): CaptureLimit | undefined {
  const per = typeof error.reason === 'string' ? PER[error.reason] : undefined;
  if (per === undefined || !isCount(error.max, 10_000) || !isCount(error.windowMinutes, 1440)) {
    return undefined;
  }
  return { per, max: error.max, windowMinutes: error.windowMinutes };
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
      // The four original fields are the frozen contract; the ones below were added later and
      // are carried through only when the server actually sent them, so this build reads an
      // older server without falling over.
      return {
        kind: 'job',
        resultId: body.resultId,
        duplicate: body.duplicate,
        refined: body.refined,
        ...(typeof body.opportunityId === 'string' ? { opportunityId: body.opportunityId } : {}),
        ...(typeof body.stage === 'string' || body.stage === null ? { stage: body.stage } : {}),
        ...(typeof body.created === 'boolean' ? { created: body.created } : {}),
        ...(typeof body.currentStage === 'string' ? { currentStage: body.currentStage } : {}),
        ...(body.description === 'added' || body.description === 'kept'
          ? { description: body.description }
          : {}),
        ...(isCount(body.linked, 1_000_000) ? { linked: body.linked } : {}),
        ...(body.filled === false ? { filled: false as const } : {}),
        ...(body.anotherPosting === true ? { anotherPosting: true as const } : {}),
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
    const limit = limitOf(errorOf(body));
    return {
      kind: 'rate_limited',
      retryAfterSec: Number.isFinite(after) ? after : null,
      ...(limit === undefined ? {} : { limit }),
    };
  }
  const error = errorOf(body);
  const code = typeof error.code === 'string' ? error.code : 'unknown';
  if (status === 422 && code === 'unrecognized_page') {
    return { kind: 'refused', reason: typeof error.reason === 'string' ? error.reason : 'unknown' };
  }
  if (status >= 400 && status < 500) return { kind: 'invalid', status, code };
  // Not a fault: the server could not take this capture at that moment, and says so (#309).
  if (status === 503 && code === 'capture_busy') {
    const after = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
    return { kind: 'busy', retryAfterSec: Number.isFinite(after) && after > 0 ? after : null };
  }
  return { kind: 'server_error', status };
}

/**
 * The largest body sent with `keepalive`. Browsers refuse more than 64 KiB of such bodies in flight,
 * and a refused request would look like a server that cannot be reached.
 */
const KEEPALIVE_MAX_BYTES = 60_000;

async function send(
  fetch: FetchLike,
  settings: Settings,
  payload: CapturePayload,
  opts: { keepalive?: boolean } = {},
) {
  const body = JSON.stringify(payload);
  const keepalive =
    opts.keepalive === true && new TextEncoder().encode(body).length <= KEEPALIVE_MAX_BYTES;
  try {
    return await fetch(captureEndpoint(settings.serverUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${settings.token}`,
        'content-type': 'application/json',
      },
      body,
      // A popup the user closes ends its requests; one already started is then finished.
      ...(keepalive ? { keepalive: true as const } : {}),
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
  const res = await send(fetch, settings, payload, { keepalive: true });
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
