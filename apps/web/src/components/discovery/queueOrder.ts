// How the review queue is ordered and dated (https://github.com/bgoleno/opportun/issues/26).
//
// A result's createdAt is when Opportun first discovered it: a later run that sees the same
// posting from the same source stores nothing (checkDuplicate in jobs/discoveryRun.ts), and no
// update ever writes createdAt. The same role seen again from another source, or in another
// location, is a new row that groups with the first (groupResults.ts), so a group is dated by
// its earliest member and a re-sighting never makes it look new.
import type { DiscoveryResult } from './api';
import { groupResults, type ResultGroup } from './groupResults';

export interface QueueSortOption {
  key: string;
  label: string;
  /** The `sort` the results endpoint is asked for, so the loaded page is the right page. */
  param: string;
  /** How groups are ordered on the client, or null to keep the server's order as is. */
  compareGroups: ((a: ResultGroup, b: ResultGroup) => number) | null;
}

/** When the queue first saw a card: its earliest member's discovery time. */
export function firstDiscoveredAt(g: ResultGroup): number {
  return Math.min(...g.members.map((m) => m.createdAt));
}

/**
 * The sort control's options, in the order it lists them. Another field is one more entry:
 * a key, a label, a server sort key from RESULT_SORTS (repos/discovery.ts), and a group
 * comparator.
 */
export const QUEUE_SORTS = [
  { key: 'relevance', label: 'Relevance', param: '-ai_score', compareGroups: null },
  {
    key: 'discovered',
    label: 'Date discovered',
    param: '-createdAt',
    compareGroups: (a, b) => firstDiscoveredAt(b) - firstDiscoveredAt(a),
  },
] as const satisfies readonly QueueSortOption[];

export type QueueSort = (typeof QUEUE_SORTS)[number]['key'];

/** The option for `key`; the relevance one for a key no option has. */
export function queueSort(key: string): QueueSortOption & { key: QueueSort } {
  return QUEUE_SORTS.find((o) => o.key === key) ?? QUEUE_SORTS[0];
}

/** The order the queue opens in: unchanged by #26, best AI score first. */
export const DEFAULT_QUEUE_SORT: QueueSort = 'relevance';

/** A card still awaiting a decision is stale once first discovered more than this long ago. */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export function isStale(g: ResultGroup, now: number): boolean {
  return (
    g.members.every((m) => m.disposition === 'pending') &&
    now - firstDiscoveredAt(g) > STALE_AFTER_MS
  );
}

/**
 * The server's relevance order (`-ai_score`: score descending, unscored last, then id
 * descending, as repos/list.ts orderBy builds it). A group's first member is the one accepting
 * the group accepts (ReviewQueue's acceptGroup), so it stays the best-scoring one under any sort.
 */
function byRelevance(a: DiscoveryResult, b: DiscoveryResult): number {
  if (a.aiScore !== b.aiScore) {
    if (a.aiScore === null) return 1;
    if (b.aiScore === null) return -1;
    return b.aiScore - a.aiScore;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** The queue's cards, in the chosen order. Relevance is the server's order, grouped as before. */
export function arrangeQueue(items: readonly DiscoveryResult[], sort: QueueSort): ResultGroup[] {
  const groups = groupResults(items);
  const compare = queueSort(sort).compareGroups;
  if (compare === null) return groups;
  return groups.map((g) => ({ ...g, members: [...g.members].sort(byRelevance) })).sort(compare);
}
