// Append-only security audit trail (NFR-SEC7). Detail is redacted before it is stored,
// so callers can pass context objects without first stripping credentials.
import { newId } from '@opportun/core';
import type { Exec } from '../db/client';
import { auditLog } from '../db/schema';

const SENSITIVE_KEY =
  /pass(word)?|token|secret|api_?key|ciphertext|cookie|authorization|^value$|^current$|^next$/i;
export const REDACTED = '[redacted]';
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
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(value, depth);
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
}
