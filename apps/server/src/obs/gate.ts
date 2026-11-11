// The privacy gate (design.md 14.8, NFR-PRV6; https://github.com/bgoleno/opportun/issues/353).
// Every sink calls it: obs.record before a metric reaches the aggregator or an exporter, the
// span sinks when they rebuild a span, and the logger for every record. It keeps a key only if
// the catalog lists it for that record, and a value only if it has the key's declared type.
//
// The rule is the absence of a field, not a pattern that hunts for personal data: a value that
// does not fit its type is dropped, never trimmed or escaped into shape. One exception, from
// 14.8: a `model` value of any other shape becomes OTHER, so a mistyped model id still counts.
//
// A wrong value is dropped and counted, always. An unknown key is dropped and counted in
// production, and throws under the test runner (VITEST), so a key added at a call site and not
// in the catalog fails CI instead of passing in silence. setUnknownKeyMode lets a test run the
// production behaviour (the property test of 14.8 does).
import { isIP } from 'node:net';
import {
  ATTRIBUTE_TYPES,
  type AttrKey,
  type AttrType,
  type Attributes,
  type AttrValue,
  type DropReason,
  OTHER,
  type Signal,
} from './catalog';

/** What happens to a key the catalog does not list for the record. */
export type UnknownKeyMode = 'drop' | 'throw';

let unknownKeyMode: UnknownKeyMode = process.env.VITEST === undefined ? 'drop' : 'throw';

/** For tests: run the production behaviour ('drop') or the test behaviour ('throw'). */
export function setUnknownKeyMode(mode: UnknownKeyMode): void {
  unknownKeyMode = mode;
}

export class UnknownTelemetryKeyError extends Error {
  constructor(readonly key: string) {
    // The key is code, never data: it is what the call site wrote, not a value.
    super(`telemetry key not in the catalog for this record: ${key}`);
    this.name = 'UnknownTelemetryKeyError';
  }
}

/** Called once per dropped key or value; obs/index.ts counts it in opportun.obs.dropped. */
export type DropCounter = (signal: Signal, reason: DropReason) => void;

/** 32 or 16 lowercase hex digits (a trace or span id), or a UUID (a row id). */
const ID =
  /^(?:[0-9a-f]{32}|[0-9a-f]{16}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** An error class, a database error code, a provider's response id (14.8). */
const CODE = /^[A-Za-z0-9_.-]{1,64}$/;
/** A model id: one or two segments of letters, digits and `. _ : -`, joined by one `/`. */
const MODEL_SEGMENT = /^[A-Za-z0-9._:-]+$/;
const MODEL_MAX = 128;

function isModelShape(value: string): boolean {
  const parts = value.split('/');
  return parts.length <= 2 && parts.every((p) => MODEL_SEGMENT.test(p));
}

/**
 * An address fits the shapes of `code` and `model` (`10.1.2.3`, `fe80::1`), and is never
 * either: a `code` refuses it and a `model` reads it as OTHER. Only an `ip` key holds one.
 */
const isAddress = (value: string): boolean => isIP(value) !== 0;

/**
 * A registered route template: a path of fixed segments, `:param` segments and `*`, with an
 * optional trailing slash. The gate cannot see the router, so it checks the shape; the HTTP
 * plugin (FR-T3) passes the route's template, never the request's path, and a path with an id
 * in it is still a plausible shape, which is why that plugin must be the only writer of
 * http.route. Checked segment by segment, so no pattern backtracks on a long input.
 */
const ROUTE_FIXED = /^[A-Za-z0-9_.-]+$/;
const ROUTE_PARAM = /^:[A-Za-z][A-Za-z0-9_]*$/;
const ROUTE_MAX = 200;
/**
 * A segment shaped like a row id: a UUID, 16 or more hex digits (a trace or span id), or all
 * digits. No route template has one, so a path that does is a request's URL, not its template,
 * and its ids would otherwise reach export (tl on #359).
 */
const ROUTE_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ROUTE_LONG_HEX = /^[0-9a-fA-F]{16,}$/;
const ROUTE_DIGITS = /^[0-9]+$/;
const isIdSegment = (seg: string): boolean =>
  ROUTE_UUID.test(seg) || ROUTE_LONG_HEX.test(seg) || ROUTE_DIGITS.test(seg);

function isRouteShape(value: string): boolean {
  if (!value.startsWith('/')) return false;
  const segments = value.slice(1).split('/');
  // A trailing slash leaves one empty last segment; "/" alone is the root.
  if (segments.at(-1) === '') segments.pop();
  return segments.every(
    (seg) => seg === '*' || ROUTE_PARAM.test(seg) || (ROUTE_FIXED.test(seg) && !isIdSegment(seg)),
  );
}

function listOf(type: Extract<AttrType, { values: unknown }>): readonly string[] {
  return typeof type.values === 'function' ? type.values() : type.values;
}

/** The value as the type accepts it, or undefined when it does not fit. */
export function checkValue(type: AttrType, value: unknown): AttrValue | undefined {
  switch (type.kind) {
    case 'enum':
      return typeof value === 'string' && listOf(type).includes(value) ? value : undefined;
    case 'enum_list': {
      if (!Array.isArray(value)) return undefined;
      const allowed = listOf(type);
      const ok = value.every((v): v is string => typeof v === 'string' && allowed.includes(v));
      return ok ? [...(value as string[])] : undefined;
    }
    case 'int':
      return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    case 'bool':
      return typeof value === 'boolean' ? value : undefined;
    case 'id':
      return typeof value === 'string' && ID.test(value) ? value : undefined;
    case 'code':
      return typeof value === 'string' && CODE.test(value) && !isAddress(value) ? value : undefined;
    case 'model':
      if (typeof value !== 'string') return undefined;
      return value.length <= MODEL_MAX && isModelShape(value) && !isAddress(value) ? value : OTHER;
    case 'route':
      if (typeof value !== 'string') return undefined;
      return value === OTHER || (value.length <= ROUTE_MAX && isRouteShape(value))
        ? value
        : undefined;
    case 'ip':
      return typeof value === 'string' && isAddress(value) ? value : undefined;
  }
}

export interface GateOptions {
  /**
   * Set only by the local log destination (obs/log.ts, FR-T5), never by a span, metric, event
   * or export path. It is what lets an `ip` key (client.address, the request's address in the
   * local access log) through: an `ip` key is log only, so the local store never holds it and
   * export never sends it (design.md 14.8, NFR-PRV6; sec's O9 on PR #352). Passing it anywhere
   * else would put a user's address in the store, so do not pass it out of habit.
   */
  localLog?: true;
}

/**
 * The attributes a record may carry: only the keys in `allowed` (the record's catalog entry),
 * each with a value of its type. Everything else is dropped and counted under `signal`. An
 * `ip` key is dropped too, unless `opts.localLog` says this is the local log (GateOptions).
 */
export function gateAttributes(
  signal: Signal,
  allowed: readonly AttrKey[],
  attrs: Readonly<Record<string, unknown>> | undefined,
  dropped: DropCounter,
  opts: GateOptions = {},
): Attributes {
  const out = new Map<AttrKey, AttrValue>();
  if (attrs === undefined) return {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    if (!(allowed as readonly string[]).includes(key)) {
      if (unknownKeyMode === 'throw') throw new UnknownTelemetryKeyError(key);
      dropped(signal, 'unknown_key');
      continue;
    }
    const type = ATTRIBUTE_TYPES.get(key);
    if (type?.kind === 'ip' && opts.localLog !== true) {
      // Catalogued, so never a throw in test mode: just not for this destination.
      dropped(signal, 'unknown_key');
      continue;
    }
    const checked = type === undefined ? undefined : checkValue(type, value);
    if (checked === undefined) {
      dropped(signal, 'invalid_value');
      continue;
    }
    out.set(key as AttrKey, checked);
  }
  return Object.fromEntries(out) as Attributes;
}
