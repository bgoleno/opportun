// Issue #26 (https://github.com/bgoleno/opportun/issues/26): the review queue's sort orders,
// each card's first-discovered date, and the stale mark. Every time here is an explicit
// timestamp, never the clock.
import { describe, expect, it } from 'vitest';
import type { DiscoveryResult } from './api';
import { groupResults } from './groupResults';
import {
  arrangeQueue,
  DEFAULT_QUEUE_SORT,
  firstDiscoveredAt,
  isStale,
  QUEUE_SORTS,
  queueSort,
  STALE_AFTER_MS,
} from './queueOrder';

const T0 = Date.parse('2026-10-01T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function result(over: Partial<DiscoveryResult> & { id: string }): DiscoveryResult {
  return {
    runId: 'run-1',
    sourceId: 'src-1',
    sourceKind: 'ats_greenhouse',
    roleTargetId: null,
    posting: { company: 'Initech', title: 'Staff Engineer', postingUrl: null, location: null },
    dedupeKey: null,
    aiScore: 80,
    aiRationale: null,
    rankSkipReason: null,
    rankDeferredAt: null,
    rankBatchSentAt: null,
    prefilterOutcome: null,
    prefilterRule: null,
    resolution: 'full',
    resolvedSourceRef: null,
    disposition: 'pending',
    opportunityId: null,
    sourceMailChannel: null,
    sourceMailExternalId: null,
    dismissReason: null,
    dismissNote: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

const ids = (groups: ReturnType<typeof arrangeQueue>) =>
  groups.map((g) => g.members.map((m) => m.id));

describe('queue sort options', () => {
  it('defaults to relevance, and offers Relevance and Date discovered, in that order', () => {
    expect(DEFAULT_QUEUE_SORT).toBe('relevance');
    expect(QUEUE_SORTS.map((s) => s.label)).toEqual(['Relevance', 'Date discovered']);
    // Each option names the server sort it asks for: relevance is the queue's existing order.
    expect(queueSort('relevance').param).toBe('-ai_score');
    expect(queueSort('discovered').param).toBe('-createdAt');
  });
});

describe('arrangeQueue', () => {
  it('relevance keeps the order the server sent (best score first), grouped as before', () => {
    const items = [
      result({ id: 'a', aiScore: 90, createdAt: T0 - 5 * DAY }),
      result({ id: 'b', aiScore: 70, createdAt: T0 }),
      result({ id: 'c', aiScore: 50, createdAt: T0 - DAY }),
    ];
    expect(arrangeQueue(items, 'relevance')).toEqual(groupResults(items));
  });

  it('date discovered puts the newest first discovered first', () => {
    // The server answers -createdAt already; the client order must agree for ungrouped rows.
    const items = [
      result({ id: 'new', createdAt: T0 }),
      result({ id: 'mid', createdAt: T0 - DAY }),
      result({ id: 'old', createdAt: T0 - 9 * DAY }),
    ];
    expect(ids(arrangeQueue([...items].reverse(), 'discovered'))).toEqual([
      ['new'],
      ['mid'],
      ['old'],
    ]);
  });

  it('dates a group by its earliest member and sorts it by that date', () => {
    // One role seen in two locations: first discovered nine days ago, seen again today. The
    // later sighting must not make the group look new.
    const early = result({
      id: 'g-austin',
      dedupeKey: 'initech|staff engineer|austin',
      createdAt: T0 - 9 * DAY,
    });
    const late = result({
      id: 'g-remote',
      dedupeKey: 'initech|staff engineer|remote',
      createdAt: T0,
    });
    const other = result({ id: 'solo', dedupeKey: 'globex|sre|remote', createdAt: T0 - DAY });
    const groups = arrangeQueue([late, other, early], 'discovered');
    expect(groups.map((g) => firstDiscoveredAt(g))).toEqual([T0 - DAY, T0 - 9 * DAY]);
    expect(ids(groups)[0]).toEqual(['solo']);
  });

  it("keeps a group's best-scoring member first under any sort, since it is the one accepted", () => {
    const a = result({
      id: 'low',
      dedupeKey: 'initech|staff engineer|austin',
      aiScore: 40,
      createdAt: T0,
    });
    const b = result({
      id: 'unscored',
      dedupeKey: 'initech|staff engineer|nyc',
      aiScore: null,
      createdAt: T0,
    });
    const c = result({
      id: 'best',
      dedupeKey: 'initech|staff engineer|remote',
      aiScore: 95,
      createdAt: T0 - DAY,
    });
    const [group] = arrangeQueue([a, b, c], 'discovered');
    expect(group!.members.map((m) => m.id)).toEqual(['best', 'low', 'unscored']);
  });
});

describe('isStale', () => {
  const group = (createdAt: number, over: Partial<DiscoveryResult> = {}) =>
    groupResults([result({ id: 'r', createdAt, ...over })])[0]!;

  it('is false at exactly seven days and just under, true just over', () => {
    expect(STALE_AFTER_MS).toBe(7 * DAY);
    const now = T0 + 7 * DAY;
    expect(isStale(group(T0 + 1), now)).toBe(false);
    expect(isStale(group(T0), now)).toBe(false);
    expect(isStale(group(T0 - 1), now)).toBe(true);
  });

  it('uses the earliest member of a group', () => {
    const now = T0 + 7 * DAY + 1;
    const [g] = groupResults([
      result({ id: 'today', dedupeKey: 'a|b|x', createdAt: now }),
      result({ id: 'first', dedupeKey: 'a|b|y', createdAt: T0 }),
    ]);
    expect(isStale(g!, now)).toBe(true);
  });

  it('only marks a card still awaiting a decision', () => {
    expect(isStale(group(T0, { disposition: 'accepted' }), T0 + 8 * DAY)).toBe(false);
  });
});
