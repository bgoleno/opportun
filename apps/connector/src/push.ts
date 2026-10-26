// Pushing to POST /api/v1/connector/mail/batch (apps/server/src/routes/connectorMail.ts):
// bearer device token with the mail:push scope; at most 100 messages, 10MB of bodies and a
// 12MB request per batch. Batches are cut client-side to stay inside all three.
import type { ConnectorConfig } from './config';
import { VERSION, type ConnectorIo, type InboundMessage } from './types';

const MB = 1024 * 1024;
export const MAX_BATCH_MESSAGES = 100;
/** All bodies of one batch, in UTF-8 bytes (the server's MAX_BATCH_BODY_BYTES). */
export const MAX_BATCH_BODY_BYTES = 10 * MB;
/** The serialized request; the server allows 12MB, this leaves room for escaping slack. */
export const MAX_BATCH_REQUEST_BYTES = 11 * MB;
/** `{"messages":[]}` */
const ENVELOPE_BYTES = 15;
/** The longest wait a 429 can impose (the server's whole window). */
const MAX_RETRY_AFTER_MS = 15 * 60 * 1000;

export function batchEndpoint(serverUrl: string): string {
  return `${serverUrl}/api/v1/connector/mail/batch`;
}

/**
 * Consecutive batches in order. A batch closes before a message that would take it past 100
 * messages, 10MB of bodies or the request budget. A single message always fits: bodies are
 * cut at 500k characters (at most 1.5MB of UTF-8) before they get here.
 */
export function splitBatches(messages: InboundMessage[]): InboundMessage[][] {
  const batches: InboundMessage[][] = [];
  let current: InboundMessage[] = [];
  let bodyBytes = 0;
  let requestBytes = ENVELOPE_BYTES;
  for (const m of messages) {
    const body = Buffer.byteLength(m.bodyText, 'utf8');
    const json = Buffer.byteLength(JSON.stringify(m), 'utf8') + 1;
    const full =
      current.length >= MAX_BATCH_MESSAGES ||
      bodyBytes + body > MAX_BATCH_BODY_BYTES ||
      requestBytes + json > MAX_BATCH_REQUEST_BYTES;
    if (full && current.length > 0) {
      batches.push(current);
      current = [];
      bodyBytes = 0;
      requestBytes = ENVELOPE_BYTES;
    }
    current.push(m);
    bodyBytes += body;
    requestBytes += json;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export type PushResult =
  | { kind: 'ok'; stored: number; inserted: number }
  | { kind: 'rate_limited'; retryAfterMs: number | null }
  | { kind: 'unauthorized' }
  | { kind: 'forbidden' }
  | { kind: 'too_large' }
  | { kind: 'server_error'; status: number }
  | { kind: 'rejected'; status: number; code: string | null }
  | { kind: 'network_error'; message: string };

function retryAfterMs(value: string | null): number | null {
  if (value === null || !/^\d{1,9}$/.test(value.trim())) return null;
  return Math.min(Number(value.trim()) * 1000, MAX_RETRY_AFTER_MS);
}

async function jsonOf(res: { text(): Promise<string> }): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await res.text());
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** One attempt; never throws (a network failure is a result like any other). */
export async function pushBatch(
  io: ConnectorIo,
  config: ConnectorConfig,
  messages: InboundMessage[],
): Promise<PushResult> {
  let res;
  try {
    res = await io.fetch(batchEndpoint(config.serverUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
        'user-agent': `opportun-connector/${VERSION}`,
      },
      body: JSON.stringify({ messages }),
    });
  } catch (err) {
    return { kind: 'network_error', message: err instanceof Error ? err.message : String(err) };
  }
  const { status } = res;
  if (status >= 200 && status < 300) {
    const body = await jsonOf(res);
    return { kind: 'ok', stored: count(body.stored), inserted: count(body.inserted) };
  }
  if (status === 429) {
    return { kind: 'rate_limited', retryAfterMs: retryAfterMs(res.headers.get('retry-after')) };
  }
  if (status === 401) return { kind: 'unauthorized' };
  if (status === 403) return { kind: 'forbidden' };
  if (status === 413) return { kind: 'too_large' };
  if (status >= 500) return { kind: 'server_error', status };
  const error = (await jsonOf(res)).error as { code?: unknown } | undefined;
  return { kind: 'rejected', status, code: typeof error?.code === 'string' ? error.code : null };
}
