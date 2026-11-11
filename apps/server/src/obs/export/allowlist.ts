// The one allowlist every exported record passes (design.md 14.8;
// https://github.com/bgoleno/opportun/issues/342, the shared export helper criterion,
// https://github.com/bgoleno/opportun/issues/342#issuecomment-6785861324).
//
// The metric, span and log exporters each call exportAttributes on what reaches their slot, so
// the same rules apply to all three signals in one place, whatever the producer already did:
// - only keys the catalog lists, and when the record names its catalog entry (a metric, an
//   event), only that entry's keys;
// - each with a value of its declared type (obs/gate.ts checkValue);
// - no local-only key: user.id and every other id not marked exportable, and client.address.
//   Export identifies no user. These are removed, not counted: leaving them behind is the rule
//   working, not something dropped by mistake;
// - a model only when the price table (PRICING) lists it, else _OTHER, in a span's name as well
//   as its attributes, which also bounds the series at the destination.
// Anything else removed is counted in opportun.obs.dropped, by signal and reason. It never
// throws: an export path must not break the code that recorded the value.
import { PRICING } from '@opportun/ai';
import {
  ATTRIBUTE_TYPES,
  type AttrKey,
  type AttrValue,
  type Attributes,
  type DropReason,
  isLocalOnly,
  OTHER,
  type Signal,
} from '../catalog';
import { checkValue } from '../gate';

/** Called once per removed key; the exporters count it in opportun.obs.dropped. */
export type ExportDropCounter = (signal: Signal, reason: DropReason) => void;

/** Every model the price table lists, under any provider: the only names export sends. */
const PRICED: ReadonlySet<string> = new Set(
  Object.values(PRICING).flatMap((models) => Object.keys(models)),
);

/** A model id as export may name it: itself when priced, else _OTHER. */
export function exportModel(value: string): string {
  return PRICED.has(value) ? value : OTHER;
}

/**
 * The attributes an exported record may carry. `allowed` is the record's catalog entry's keys,
 * when it has one (a metric's or an event's); a span is checked against the whole catalog, its
 * entry having been matched when it was rebuilt (obs/spanRebuild.ts, FR-T4 part 2).
 */
export function exportAttributes(
  signal: Signal,
  attributes: Readonly<Record<string, unknown>>,
  allowed: readonly string[] | undefined,
  dropped: ExportDropCounter,
): Attributes {
  const out: Record<string, AttrValue> = {};
  const listed = allowed === undefined ? undefined : new Set(allowed);
  for (const [key, value] of Object.entries(attributes)) {
    const type = ATTRIBUTE_TYPES.get(key);
    if (type === undefined || (listed !== undefined && !listed.has(key))) {
      dropped(signal, 'unknown_key');
      continue;
    }
    if (isLocalOnly(key as AttrKey)) continue;
    const checked = checkValue(type, value);
    if (checked === undefined) {
      dropped(signal, 'invalid_value');
      continue;
    }
    // eslint-disable-next-line security/detect-object-injection -- key is a catalogued name
    out[key] =
      type.kind === 'model' && typeof checked === 'string' ? exportModel(checked) : checked;
  }
  return out as Attributes;
}

/**
 * The one span name template that carries a model: `chat {gen_ai.request.model}`
 * (packages/ai/src/telemetry.ts spanNameFor). Every other template is filled with enum values.
 */
const CHAT_PREFIX = 'chat ';

/** A span's name as export may send it: a `chat` span names a priced model only. */
export function exportSpanName(name: string): string {
  if (!name.startsWith(CHAT_PREFIX)) return name;
  return `${CHAT_PREFIX}${exportModel(name.slice(CHAT_PREFIX.length))}`;
}
