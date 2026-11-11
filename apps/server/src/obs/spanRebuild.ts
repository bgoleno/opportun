// Rebuilding a span from the catalog (design.md 14.8; https://github.com/bgoleno/opportun/issues/344).
// Both span sinks call this, the local store and the export slot: a span is never passed on as it
// was made. Its attributes are copied out through the gate, its name is taken from a catalogued
// template filled with checked values, and its events, links and status text are left behind. A
// span that matches no catalogued name and kind is dropped whole and counted, wherever it comes
// from (packages/ai, a dependency, the API used directly).
import { SpanKind, SpanStatusCode, type HrTime } from '@opentelemetry/api';
import { PRICING } from '@opportun/ai';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import {
  ATTRIBUTE_TYPES,
  type AttrKey,
  type Attributes,
  type DropReason,
  OTHER,
  SPANS,
  type SpanDef,
  withoutLocalOnly,
} from './catalog';
import { gateAttributes, UnknownTelemetryKeyError } from './gate';
import { obs, type GatedSpan } from './index';

/** Counts a span the gate or a buffer dropped (opportun.obs.dropped). */
export function countSpanDrop(reason: DropReason): void {
  obs.record('opportun.obs.dropped', 1, {
    'opportun.obs.signal': 'spans',
    'opportun.obs.reason': reason,
  });
}

const KIND_NAMES: Record<SpanKind, SpanDef['kind']> = {
  [SpanKind.INTERNAL]: 'internal',
  [SpanKind.SERVER]: 'server',
  [SpanKind.CLIENT]: 'client',
  [SpanKind.PRODUCER]: 'producer',
  [SpanKind.CONSUMER]: 'consumer',
};

/** A template's literal part before its first `{key}` (`chat`), and that key. */
function templateParts(template: string): { prefix: string; key: AttrKey | undefined } {
  const at = template.indexOf('{');
  if (at < 0) return { prefix: template, key: undefined };
  const end = template.indexOf('}', at);
  return { prefix: template.slice(0, at).trimEnd(), key: template.slice(at + 1, end) as AttrKey };
}

const isModelKey = (key: AttrKey): boolean => ATTRIBUTE_TYPES.get(key)?.kind === 'model';

/**
 * A span's name from its template, filled with checked values only. A model that is OTHER (not
 * shaped like one, or not priced, for export) leaves the template's literal part: `chat`.
 */
function fillName(template: string, attributes: Attributes): string {
  const { prefix, key } = templateParts(template);
  if (key === undefined) return template;
  const value = (attributes as Record<string, unknown>)[key];
  if (isModelKey(key) && (value === undefined || value === OTHER)) return prefix;
  if (typeof value !== 'string' && typeof value !== 'number') return prefix;
  return template.replace(`{${key}}`, String(value));
}

const noDrop = (): void => undefined;

/**
 * The catalog entry a span was made from: the same kind, and the name its template gives from
 * the span's own checked value (or the literal part, when that value is not shaped right).
 */
export function spanDefOf(span: ReadableSpan): SpanDef | undefined {
  const kind = KIND_NAMES[span.kind];
  for (const def of Object.values(SPANS) as SpanDef[]) {
    if (def.kind !== kind) continue;
    const { prefix, key } = templateParts(def.template);
    if (key === undefined) {
      if (span.name === def.template) return def;
      continue;
    }
    // Only the template's own key is checked here, so no other key can throw in test mode.
    const one = gateAttributes('spans', [key], { [key]: span.attributes[key] }, noDrop);
    if (span.name === fillName(def.template, one)) return def;
    if (prefix !== '' && span.name === prefix && isModelKey(key)) return def;
  }
  return undefined;
}

const hrMs = (t: HrTime): number => t[0] * 1000 + t[1] / 1e6;

/** Every model the price table lists, by provider: the only ones export names (14.8). */
const PRICED = new Set(Object.values(PRICING).flatMap((models) => Object.keys(models)));

/**
 * A span rebuilt from its catalog entry, or undefined when it matches none (dropped and counted).
 * `export` also drops the local-only keys and names a model only when it is priced (sec's O2 on
 * PR #357: the name as well as the attributes).
 */
export function rebuildSpan(span: ReadableSpan, sink: 'local' | 'export'): GatedSpan | undefined {
  const def = spanDefOf(span);
  if (def === undefined) {
    countSpanDrop('unknown_key');
    return undefined;
  }
  let attributes = gateAttributes('spans', def.attributes, span.attributes, (_signal, reason) =>
    countSpanDrop(reason),
  );
  if (sink === 'export') {
    attributes = withoutLocalOnly(attributes);
    for (const [key, value] of Object.entries(attributes)) {
      if (isModelKey(key as AttrKey) && typeof value === 'string' && !PRICED.has(value)) {
        (attributes as Record<string, unknown>)[key] = OTHER;
      }
    }
  }
  const ctx = span.spanContext();
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentSpanId: span.parentSpanContext?.spanId ?? null,
    name: fillName(def.template, attributes),
    kind: def.kind,
    startMs: hrMs(span.startTime),
    durationMs: Math.max(0, hrMs(span.duration)),
    status: span.status.code === SpanStatusCode.ERROR ? 'error' : 'ok',
    attributes,
  };
}

/**
 * Runs a processor's step so that it can never break the code that ended the span: a failure is
 * dropped and counted. A key missing from the catalog still throws under the test runner, as the
 * gate means it to (a mistake in code fails CI), and is dropped in production.
 */
export function guarded(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    if (err instanceof UnknownTelemetryKeyError) throw err;
    countSpanDrop('invalid_value');
  }
}
