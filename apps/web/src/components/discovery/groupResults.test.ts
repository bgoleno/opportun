// Issue #191: one role advertised in several locations produces one dedupeKey per location, so
// the review queue showed the same job as several rows to triage. Grouping by company+title for
// DISPLAY, without touching dedupeKey or checkDuplicate, keeps every row distinct and
// individually recoverable: nothing is merged, so nothing can silently stop existing the way
// narrowing the dedupe key itself would risk (see the issue and PurgeCard-style three-state
// precedent this session already applied elsewhere for the same "don't hide a real state"
// reason).
import { describe, expect, it } from 'vitest';
import type { DiscoveryResult } from './api';
import { groupResults } from './groupResults';

const NOW = Date.now();

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
    resolution: 'full',
    resolvedSourceRef: null,
    disposition: 'pending',
    opportunityId: null,
    sourceMailChannel: null,
    sourceMailExternalId: null,
    dismissReason: null,
    dismissNote: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

describe('groupResults', () => {
  it('groups results sharing a company+title dedupeKey prefix, dropping only the location segment', () => {
    // The real shape measured on the live instance (issue #191): three states, one role.
    const ca = result({
      id: 'r-ca',
      dedupeKey: 'vandelay|technical product manager enterprise products|california united states',
    });
    const co = result({
      id: 'r-co',
      dedupeKey: 'vandelay|technical product manager enterprise products|colorado united states',
    });
    const nc = result({
      id: 'r-nc',
      dedupeKey:
        'vandelay|technical product manager enterprise products|north carolina united states',
    });
    const groups = groupResults([ca, co, nc]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe('vandelay|technical product manager enterprise products');
    expect(groups[0]?.members).toEqual([ca, co, nc]);
  });

  it('never groups across different titles or companies, even at the same company', () => {
    const pm = result({
      id: 'r-pm',
      dedupeKey: 'globex networks|senior product manager|san francisco ca',
    });
    const pm2 = result({
      id: 'r-pm2',
      dedupeKey: 'globex networks|senior product manager|santa clara ca',
    });
    const chrono = result({
      id: 'r-chrono',
      dedupeKey: 'globex networks|senior product manager chronosphere|boston ma',
    });
    const groups = groupResults([pm, pm2, chrono]);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.key === 'globex networks|senior product manager')?.members).toEqual(
      [pm, pm2],
    );
    expect(
      groups.find((g) => g.key === 'globex networks|senior product manager chronosphere')?.members,
    ).toEqual([chrono]);
  });

  it('keeps a result with no dedupeKey in its own group rather than merging it with anything', () => {
    // Should not happen for a pending row (every ingested posting gets a key), but a grouping
    // helper must never assume that and silently fold a keyless row into someone else's group.
    const noKey1 = result({ id: 'r-nokey-1', dedupeKey: null });
    const noKey2 = result({ id: 'r-nokey-2', dedupeKey: null });
    const groups = groupResults([noKey1, noKey2]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.members)).toEqual([[noKey1], [noKey2]]);
  });

  it('preserves incoming order across groups (by first-seen member) and within a group', () => {
    const b1 = result({ id: 'b1', aiScore: 91, dedupeKey: 'b|t|loc1' });
    const a1 = result({ id: 'a1', aiScore: 80, dedupeKey: 'a|t|loc1' });
    const b2 = result({ id: 'b2', aiScore: 70, dedupeKey: 'b|t|loc2' });
    // Incoming order is already best-score-first; b1 appears before a1, so b's group is first.
    const groups = groupResults([b1, a1, b2]);
    expect(groups.map((g) => g.key)).toEqual(['b|t', 'a|t']);
    expect(groups[0]?.members).toEqual([b1, b2]);
  });

  it('returns a singleton group for a result that shares no key with anything else', () => {
    const solo = result({ id: 'solo', dedupeKey: 'acme|engineer|remote' });
    const groups = groupResults([solo]);
    expect(groups).toEqual([{ key: 'acme|engineer', members: [solo] }]);
  });

  it('returns no groups for an empty list', () => {
    expect(groupResults([])).toEqual([]);
  });
});
