// Candidate ranking (Task 2): the postings on a board, scored against the opportunity's title
// with FR-D7's titleOverlap, with one role posted in several locations collapsed to one row.
import type { NormalizedPosting } from '@opportun/core';
import { describe, expect, it } from 'vitest';
import { rankCandidates } from '../src/lib/postingCandidates';

/** A board posting with a description: the only kind that can be attached. */
function full(title: string): NormalizedPosting {
  return {
    company: 'Sentinel Edge',
    title,
    descriptionMd: 'What We Do: cybercrime is growing.',
    location: 'United States',
  };
}

describe('rankCandidates', () => {
  it('ranks by title overlap and drops partials', () => {
    const ranked = rankCandidates(
      [
        full('Staff Product Manager, SIEM'),
        full('Reseller Sales Manager'),
        { ...full('Senior Product Manager, SOC Experience'), descriptionMd: null },
      ],
      'Product Manager, SIEM',
    );
    expect(ranked.map((c) => c.posting.title)).toEqual([
      'Staff Product Manager, SIEM',
      'Reseller Sales Manager',
    ]);
    expect(ranked[0]!.score).toBeCloseTo(0.75, 2);
  });

  it('collapses one role posted in several locations, preferring the US', () => {
    const ranked = rankCandidates(
      [
        { ...full('Principal Product Manager Platform and Context'), location: 'Canada' },
        { ...full('Principal Product Manager Platform and Context'), location: 'United States' },
      ],
      'Principal Product Manager Platform and Context',
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.posting.location).toBe('United States');
    expect(ranked[0]!.otherLocations).toEqual(['Canada']);
  });

  it('keeps same-titled postings apart when their descriptions differ', () => {
    const ranked = rankCandidates(
      [
        { ...full('Product Manager'), descriptionMd: 'a'.repeat(300) },
        { ...full('Product Manager'), descriptionMd: 'b'.repeat(300) },
      ],
      'Product Manager',
    );
    expect(ranked).toHaveLength(2);
  });

  it('honours a different preferred location', () => {
    const ranked = rankCandidates(
      [
        { ...full('Staff Product Manager'), location: 'United States' },
        { ...full('Staff Product Manager'), location: 'Ireland' },
      ],
      'Staff Product Manager',
      'Ireland',
    );
    expect(ranked[0]!.posting.location).toBe('Ireland');
    expect(ranked[0]!.otherLocations).toEqual(['United States']);
  });

  it('returns nothing when every posting is partial', () => {
    expect(
      rankCandidates([{ ...full('Product Manager'), descriptionMd: '  ' }], 'Product Manager'),
    ).toEqual([]);
    expect(rankCandidates([], 'Product Manager')).toEqual([]);
  });
});
