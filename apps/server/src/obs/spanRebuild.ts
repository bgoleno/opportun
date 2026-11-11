// Rebuilding a span from the catalog (design.md 14.8; https://github.com/bgoleno/opportun/issues/344).
// Both span sinks call this, the local store and the export slot: a span is never passed on as it
// was made. Its attributes are copied out through the gate, its name is taken from a catalogued
// template filled with checked values, and its events, links and status text are left behind. A
// span that matches no catalogued name and kind is dropped whole and counted, wherever it comes
// from (packages/ai, a dependency, the API used directly).
import { SpanKind, SpanStatusCode, type HrTime } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import {
  ATTRIBUTE_TYPES,
  type AttrKey,
  type Attributes,
  type DropReason,
  OTHER,
  SPANS,
  type SpanDef,
} from './catalog';
import { exportAttributes } from './export/allowlist';
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

/** Every `{key}` a template names, in order. */
function templateKeys(template: string): AttrKey[] {
  return [...template.matchAll(/\{([a-z0-9_.]+)\}/g)].map((m) => m[1] as AttrKey);
}

/** A template's literal part before its first `{key}` (`chat`): its name when a model is OTHER. */
function templatePrefix(template: string): string {
  const at = template.indexOf('{');
  return at < 0 ? template : template.slice(0, at).trimEnd();
}

const isModelKey = (key: AttrKey): boolean => ATTRIBUTE_TYPES.get(key)?.kind === 'model';

/**
 * A span's name from its template, filled with checked values only, every key of it (a route's
 * span has two). A model that is OTHER (not shaped like one, or not priced, for export) leaves the
 * template's literal part: `chat`. Any other key with no checked value leaves its place empty.
 */
function fillName(template: string, attributes: Attributes): string {
  const values = new Map(Object.entries(attributes));
  for (const key of templateKeys(template)) {
    const value = values.get(key);
    if (isModelKey(key) && (value === undefined || value === OTHER))
      return templatePrefix(template);
  }
  return template.replace(/\{([a-z0-9_.]+)\}/g, (_m, key: string) => {
    const value = values.get(key);
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  });
}

const noDrop = (): void => undefined;

/** The kinds a catalog entry allows: `kinds` when it has several (a job), else its `kind`. */
const kindsOf = (def: SpanDef): readonly SpanDef['kind'][] => def.kinds ?? [def.kind];

/**
 * The catalog entry a span was made from: one of its kinds, and the name its template gives from
 * the span's own checked values (or the literal part, when a model is not shaped right).
 */
export function spanDefOf(span: ReadableSpan): SpanDef | undefined {
  const kind = KIND_NAMES[span.kind];
  for (const def of Object.values(SPANS) as SpanDef[]) {
    if (!kindsOf(def).includes(kind)) continue;
    const keys = templateKeys(def.template);
    if (keys.length === 0) {
      if (span.name === def.template) return def;
      continue;
    }
    // Only the template's own keys are checked here, so no other key can throw in test mode.
    const own = new Map(Object.entries(span.attributes));
    const checked = gateAttributes(
      'spans',
      keys,
      Object.fromEntries(keys.map((k) => [k, own.get(k)])),
      noDrop,
    );
    if (span.name === fillName(def.template, checked)) return def;
    const prefix = templatePrefix(def.template);
    if (prefix !== '' && span.name === prefix && keys.some(isModelKey)) return def;
  }
  return undefined;
}

const hrMs = (t: HrTime): number => t[0] * 1000 + t[1] / 1e6;

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
    // The one export allowlist every signal passes (obs/export/allowlist.ts, #342): no local-only
    // key, and a model named only when it is priced, so the name filled below follows suit.
    attributes = exportAttributes('spans', attributes, def.attributes, (_signal, reason) =>
      countSpanDrop(reason),
    );
  }
  const ctx = span.spanContext();
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentSpanId: span.parentSpanContext?.spanId ?? null,
    name: fillName(def.template, attributes),
    // The span's own kind, one of the entry's (a continued job is a consumer, 14.2).
    kind: KIND_NAMES[span.kind],
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
