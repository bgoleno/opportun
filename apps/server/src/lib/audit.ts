// Append-only security audit trail (NFR-SEC7). Detail is redacted before it is stored,
// so callers can pass context objects without first stripping credentials.
import { newId } from '@opportun/core';
import type { Exec } from '../db/client';
import { auditLog } from '../db/schema';
import { obs } from '../obs';
import { isEventName } from '../obs/catalog';

// `answers`, `fields`, `resume` and `text` (assisted apply M1c, issue #116; design Part A 7.3):
// a submission's answers and profile values are the user's own words, like notes, so a careless
// caller passing them in audit detail stores the redaction instead. Exact keys only, so ids
// such as `resumeId` stay readable.
const SENSITIVE_KEY =
  /pass(word)?|token|secret|api_?key|ciphertext|cookie|authorization|^value$|^current$|^next$|^answers$|^fields$|^resume$|^text$/i;
export const REDACTED = '[redacted]';
/**
 * A key naming which token acted, not the token itself (`deviceTokenId`, #182): kept when its
 * value has the shape of a row id (newId, a UUID), so the owner can tell which device to revoke.
 * Any other value under such a key, a credential included, is redacted as before.
 */
const TOKEN_ID_KEY = /tokenId$/i;
const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keptTokenId = (key: string, value: unknown): boolean =>
  TOKEN_ID_KEY.test(key) && typeof value === 'string' && ROW_ID.test(value);
const MAX_DEPTH = 5;

function redact(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    return redactDetail(value as Record<string, unknown>, depth + 1);
  }
  return value;
}

/** Replaces values under credential-looking keys, recursively. */
export function redactDetail(detail: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    // eslint-disable-next-line security/detect-object-injection -- out is a fresh local object
    out[key] =
      SENSITIVE_KEY.test(key) && !keptTokenId(key, value) ? REDACTED : redact(value, depth);
  }
  return out;
}

export async function audit(
  exec: Exec,
  event: string,
  opts: { userId?: string; ip?: string; detail?: Record<string, unknown> },
): Promise<void> {
  await exec
    .insert(auditLog)
    .values({
      id: newId(),
      userId: opts.userId ?? null,
      event,
      detail: opts.detail === undefined ? null : redactDetail(opts.detail),
      ip: opts.ip ?? null,
      createdAt: Date.now(),
    })
    .run();
  // Every audit action is also an event (design 14.9), emitted here so no call site changes:
  // its name and its user only, never its detail or address. With collection off this returns
  // after one check. A name the catalog does not list (a test's) is not an event.
  if (isEventName(event)) {
    obs.event(event, {}, opts.userId === undefined ? {} : { userId: opts.userId });
  }
}
