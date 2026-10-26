// Issue #191: the same role advertised in several locations produces a different dedupeKey
// per location (`company|title|location`), so the review queue listed one row per location for
// what the user sees as one job. Grouping here is display-only: it never touches dedupeKey,
// checkDuplicate or any stored row, so nothing about identity changes and nothing a user hasn't
// decided on can silently disappear -- narrowing the dedupe key itself was rejected for exactly
// that risk (see the issue). Every member stays its own row underneath; this only decides how
// many cards the queue renders.
import type { DiscoveryResult } from './api';

export interface ResultGroup {
  /** dedupeKey's company+title segments, with the location segment dropped. Unique per member
   *  when a result has no dedupeKey (should not happen for a pending row, but never assumed),
   *  so a keyless result always gets its own singleton group. */
  key: string;
  members: readonly DiscoveryResult[];
}

/** `dedupeKey`'s normalize() only narrows to `[a-z0-9 ]`, so `|` never appears in its company or
 *  title segments: splitting on `|` and keeping the first two segments is a safe way to drop
 *  only the location segment, not a heuristic over the posting's own text. */
function groupKeyOf(r: DiscoveryResult): string {
  return r.dedupeKey === null ? `#${r.id}` : r.dedupeKey.split('|').slice(0, 2).join('|');
}

/** Groups results sharing a company+title key, preserving the incoming order: groups appear in
 *  the order their first member was seen, and members keep their relative order within a group
 *  (the queue's own list is already best-AI-score-first, so both stay sorted that way too). */
export function groupResults(items: readonly DiscoveryResult[]): ResultGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, DiscoveryResult[]>();
  for (const r of items) {
    const key = groupKeyOf(r);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, [r]);
      order.push(key);
    } else {
      existing.push(r);
    }
  }
  return order.map((key) => ({ key, members: byKey.get(key) ?? [] }));
}

/** The DOM/selection id a row renders under: a singleton group behaves exactly as a plain
 *  result row always has (keyed by the result's own id), and only an actual multi-member group
 *  introduces the new `key`-based identity, which is never a real result id and never confused
 *  for one. */
export function rowKey(g: ResultGroup): string {
  return g.members.length === 1 ? g.members[0]!.id : g.key;
}
