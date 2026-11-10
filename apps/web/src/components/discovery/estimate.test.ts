// The estimate line on a Recommended companies row (https://github.com/bgoleno/opportun/issues/301,
// N5b-c of #222), with the formulas in tl's note and his answers on #301: 2% of the open jobs are
// new each day, the pre-filter's matches are what gets ranked while it acts, the first run is at
// most 25, and every count costs the 30-day average of a rank call. Pure functions over the figures
// the page has already read. Every name is made up.
import { describe, expect, it } from 'vitest';
import type { CompanyView } from './companiesApi';
import type { DiscoverySource } from './api';
import type { SourceVolumeFigures } from './costFigures';
import { estimateOf, estimateText, FIRST_RUN_RANK_CAP, type EstimateInputs } from './estimate';

const NOW = 1_700_000_000_000;

function company(over: Partial<CompanyView> = {}): CompanyView {
  return {
    id: 'c1',
    userId: 'u1',
    name: 'Initech',
    status: 'suggested',
    suggestionRationale: null,
    atsKind: 'ats_greenhouse',
    atsRef: 'initech',
    atsVerifiedAt: NOW,
    careersUrl: null,
    atsDetectPending: false,
    needsCareersUrl: false,
    createdAt: NOW,
    updatedAt: NOW,
    boardProbedAt: NOW,
    boardOpenJobs: 200,
    boardPrefilterMatches: 40,
    boardProbePending: false,
    ...over,
  };
}

const inputs = (over: Partial<EstimateInputs> = {}): EstimateInputs => ({
  company: company(),
  source: undefined,
  volume: undefined,
  costPerCall: 0.02,
  recallOn: true,
  ...over,
});

const text = (over: Partial<EstimateInputs> = {}): string | null => {
  const e = estimateOf(inputs(over));
  return e === null ? null : estimateText(e);
};

describe('the estimate of a company not followed', () => {
  it('2% of the open jobs are new a day, the matches are ranked, the first run is at most 25', () => {
    expect(FIRST_RUN_RANK_CAP).toBe(25);
    expect(estimateOf(inputs())).toEqual({
      newPerDay: 4,
      rankedPerDay: 0.8,
      costPerDayUsd: 0.016,
      firstRun: { count: 25, usd: 0.5 },
    });
    expect(text()).toBe('about 4 new a day, est. $0.02 a day; first run 25, $0.50');
  });

  it('a first run under the cap is the matches', () => {
    expect(text({ company: company({ boardOpenJobs: 30, boardPrefilterMatches: 12 }) })).toBe(
      'about 0.6 new a day, est. under $0.01 a day; first run 12, $0.24',
    );
  });

  it('without the pre-filter acting, everything is ranked: the matches are the open jobs', () => {
    expect(estimateOf(inputs({ recallOn: false }))).toMatchObject({
      rankedPerDay: 4,
      firstRun: { count: 25 },
    });
    // The source's own switch off, the same.
    expect(
      estimateOf(
        inputs({ source: { prefilterEnabled: false } as DiscoverySource, recallOn: true }),
      ),
    ).toMatchObject({ rankedPerDay: 4 });
    // A source the probe made, switch on, and the rule met: the matches count.
    expect(
      estimateOf(inputs({ source: { prefilterEnabled: true } as DiscoverySource })),
    ).toMatchObject({ rankedPerDay: 0.8 });
  });

  it('with no role target to judge against, there are no matches and everything is ranked', () => {
    expect(
      estimateOf(inputs({ company: company({ boardPrefilterMatches: null, boardOpenJobs: 50 }) })),
    ).toMatchObject({ newPerDay: 1, rankedPerDay: 1, firstRun: { count: 25 } });
    expect(
      estimateOf(inputs({ company: company({ boardPrefilterMatches: null, boardOpenJobs: 10 }) })),
    ).toMatchObject({ firstRun: { count: 10 } });
  });

  it('says "cost not known yet" with no rank call in 30 days, and keeps the counts', () => {
    expect(text({ costPerCall: null })).toBe(
      'about 4 new a day; first run 25 postings (cost not known yet)',
    );
    expect(estimateOf(inputs({ costPerCall: null }))).toMatchObject({
      costPerDayUsd: null,
      firstRun: { count: 25, usd: null },
    });
  });

  it('is nothing without a probe, with no board, or for a board with no open jobs read', () => {
    expect(text({ company: company({ boardOpenJobs: null, boardProbedAt: null }) })).toBeNull();
    expect(text({ company: company({ atsKind: 'none', boardOpenJobs: null }) })).toBeNull();
    // A listing that could not be read: probed, with nothing to count.
    expect(text({ company: company({ boardOpenJobs: null }) })).toBeNull();
  });

  it('a board with no open jobs: nothing new, nothing to rank', () => {
    expect(text({ company: company({ boardOpenJobs: 0, boardPrefilterMatches: 0 }) })).toBe(
      'under 0.1 new a day, est. $0.00 a day; first run 0, $0.00',
    );
  });
});

describe('how the figures read', () => {
  const rate = (open: number) =>
    text({ company: company({ boardOpenJobs: open, boardPrefilterMatches: open }) });

  it('under 0.1 a day says so; under 10 has one decimal; from 10 it is whole', () => {
    expect(rate(4)).toMatch(/^under 0\.1 new a day/);
    expect(rate(30)).toMatch(/^about 0\.6 new a day/);
    expect(rate(499)).toMatch(/^about 10 new a day/);
    expect(rate(450)).toMatch(/^about 9 new a day/);
    expect(rate(1000)).toMatch(/^about 20 new a day/);
    expect(rate(212)).toMatch(/^about 4\.2 new a day/);
  });

  it('dollars have two places, and under a cent say so', () => {
    expect(text({ costPerCall: 0.0004 })).toContain('est. under $0.01 a day');
    expect(text({ costPerCall: 0.015 })).toContain('first run 25, $0.38');
    expect(text({ costPerCall: 0 })).toContain('est. $0.00 a day');
  });

  it('one posting is not "postings" in the first run line without a cost', () => {
    expect(
      text({
        company: company({ boardOpenJobs: 1, boardPrefilterMatches: 1 }),
        costPerCall: null,
      }),
    ).toContain('first run 1 posting (cost not known yet)');
  });
});

describe('the estimate of a followed company: the daily part only', () => {
  const followed = company({ status: 'followed' });
  const source = { id: 's1', companyId: 'c1', prefilterEnabled: true } as DiscoverySource;
  const volume = (over: Partial<SourceVolumeFigures>): SourceVolumeFigures => ({
    sourceId: 's1',
    kind: 'ats_greenhouse',
    openJobs: 300,
    newPerDay: 9,
    days: 14,
    rankCallsPerDay: 2,
    costPerDayUsd: 0.04,
    belowCut: 0,
    belowCutCostUsd: null,
    ...over,
  });

  it('once the source has 14 days of runs, new a day is what it saw', () => {
    const e = estimateOf(inputs({ company: followed, source, volume: volume({}) }));
    expect(e).toMatchObject({ newPerDay: 9, firstRun: null });
    expect(estimateText(e!)).toBe('about 9 new a day, est. $0.04 a day');
  });

  it("before that it is 2% of the open jobs, from the source's own latest run first", () => {
    const e = estimateOf(
      inputs({
        company: followed,
        source,
        volume: volume({ days: 5, newPerDay: 99, openJobs: 300 }),
      }),
    );
    // 2% of 300, never the 99 seen over 5 days; the probe's 200 is not used while the run knows 300.
    expect(e).toMatchObject({ newPerDay: 6 });
    // No run figures at all: the probe's count.
    expect(estimateOf(inputs({ company: followed, source, volume: undefined }))).toMatchObject({
      newPerDay: 4,
    });
  });

  it('13 days of runs is not enough: the 2% rule holds until the 14th day (tl on #325)', () => {
    const at = (days: number) =>
      estimateOf(
        inputs({
          company: followed,
          source,
          volume: volume({ days, newPerDay: 99, openJobs: 300 }),
        }),
      )!.newPerDay;
    expect(at(13)).toBe(6);
    expect(at(14)).toBe(99);
    expect(at(30)).toBe(99);
  });

  it('shows no first run, and nothing for a followed company with no board or no count', () => {
    expect(
      estimateOf(inputs({ company: followed, source, volume: volume({}) }))!.firstRun,
    ).toBeNull();
    expect(text({ company: company({ status: 'followed', atsKind: 'none' }) })).toBeNull();
    expect(
      text({ company: company({ status: 'followed', boardOpenJobs: null }), volume: undefined }),
    ).toBeNull();
  });

  it('says "cost not known yet" the same way', () => {
    const e = estimateOf(
      inputs({ company: followed, source, volume: volume({}), costPerCall: null }),
    );
    expect(estimateText(e!)).toBe('about 9 new a day (cost not known yet)');
  });
});
