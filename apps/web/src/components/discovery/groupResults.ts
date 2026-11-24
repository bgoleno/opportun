// Issue #191: the same role advertised in several locations produces a different dedupeKey
// per location (`company|title|location`), so the review queue listed one row per location for
// what the user sees as one job. Grouping here is display-only: it never touches dedupeKey,
// checkDuplicate or any stored row, so nothing about identity changes and nothing a user hasn't
// decided on can silently disappear -- narrowing the dedupe key itself was rejected for exactly
// that risk (see the issue). Every member stays its own row underneath; this only decides how
// many cards the queue renders.
import { cardKey } from '@opportun/core';
import type { DiscoveryResult } from './api';

export interface ResultGroup {
  /** The card's key (@opportun/core cardKey): one company and one whole title, whatever the
   *  location. Unique per member when a result has no dedupeKey (should not happen for a pending
   *  row, but never assumed), so a keyless result always gets its own singleton group. */
  key: string;
  members: readonly DiscoveryResult[];
}

function groupKeyOf(r: DiscoveryResult): string {
  return r.dedupeKey === null
    ? `#${r.id}`
    : cardKey(r.dedupeKey, r.posting.company, r.posting.title);
}

/** Groups the results of one card (cardKey), preserving the incoming order: groups appear in
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
