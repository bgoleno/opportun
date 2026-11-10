// The Recommended companies list's data (https://github.com/bgoleno/opportun/issues/300, slice b of
// #222): one row for each company, from the user's network and from the suggestions, with the
// filters and the two sorts. Everything here works on what the page has already loaded: a filter or
// a sort cannot make a request, so it cannot reach the network or call the AI provider.
import type { NaicsTier } from '@opportun/core';
import type { BoardState, CompanyView, IndustryRow, NetworkCompany } from './companiesApi';

export interface Recommended {
  company: CompanyView;
  /** Where the company came from: both, when a suggestion is also someone the user knows. */
  sources: { network: boolean; suggested: boolean };
  contactCount: number;
  contacts: NetworkCompany['contacts'];
  board: BoardState;
}

export type SourceFilter = 'all' | 'network' | 'suggested';
export type BoardFilter = 'any' | BoardState;
export type RecommendedSort = 'people' | 'fit';

export interface RecommendedFilters {
  source: SourceFilter;
  /** 'all', 'code:<naics code>' for a confirmed profile row, 'other' or 'untagged'. */
  industry: string;
  board: BoardFilter;
}

export const NO_FILTERS: RecommendedFilters = { source: 'all', industry: 'all', board: 'any' };

/** found: a board kind is recorded; not_found: detection found none; not_checked: never run. */
export function boardOf(c: CompanyView): BoardState {
  if (c.atsKind == null) return 'not_checked';
  return c.atsKind === 'none' ? 'not_found' : 'found';
}

/**
 * The network's companies and the suggestions, each company once. A suggestion the user also knows
 * someone at is one row with both sources. The network's order first, then the suggestions that
 * have no contact: the caller sorts.
 */
export function mergeRecommended(
  network: readonly NetworkCompany[],
  suggestions: readonly CompanyView[],
): Recommended[] {
  const rows = new Map<string, Recommended>();
  for (const n of network) {
    rows.set(n.company.id, {
      company: n.company,
      sources: { network: true, suggested: n.company.status === 'suggested' },
      contactCount: n.contactCount,
      contacts: n.contacts,
      board: boardOf(n.company),
    });
  }
  for (const s of suggestions) {
    // Already a row from the network: its status says it is a suggestion, so it has both badges.
    if (rows.has(s.id)) continue;
    rows.set(s.id, {
      company: s,
      sources: { network: false, suggested: true },
      contactCount: 0,
      contacts: [],
      board: boardOf(s),
    });
  }
  return [...rows.values()];
}

/** How a company's industry tag stands against the confirmed profile. */
export type Fit =
  { kind: 'tier'; tier: NaicsTier; row: IndustryRow } | { kind: 'other' } | { kind: 'untagged' };

/** A company with no code is not tagged, whether it has not been asked or the model could not place it. */
export function fitOf(c: CompanyView, profile: readonly IndustryRow[]): Fit {
  if (c.naicsCode == null) return { kind: 'untagged' };
  const row = profile.find((r) => r.code === c.naicsCode);
  return row === undefined ? { kind: 'other' } : { kind: 'tier', tier: row.tier, row };
}

const TIER_RANK: Record<NaicsTier, number> = { core: 0, similar: 1, adjacent: 2 };

function fitRank(fit: Fit): number {
  if (fit.kind === 'tier') return TIER_RANK[fit.tier];
  return fit.kind === 'other' ? 3 : 4;
}

/** What the profile calls each tier, in the user's words: core is "yours". */
export const TIER_WORDS: Record<NaicsTier, string> = {
  core: 'yours',
  similar: 'similar',
  adjacent: 'adjacent',
};

const TIER_GROUPS: [NaicsTier, string][] = [
  ['core', 'Yours'],
  ['similar', 'Similar'],
  ['adjacent', 'Adjacent'],
];

export interface IndustryOption {
  value: string;
  label: string;
  /** The optgroup it sits in, or null for the options outside any. */
  group: string | null;
}

/** All, then each confirmed profile row by tier, then Other industries and Not tagged yet. */
export function industryOptions(profile: readonly IndustryRow[]): IndustryOption[] {
  const options: IndustryOption[] = [{ value: 'all', label: 'All industries', group: null }];
  for (const [tier, group] of TIER_GROUPS) {
    for (const r of profile.filter((p) => p.tier === tier)) {
      options.push({ value: `code:${r.code}`, label: r.title, group });
    }
  }
  options.push(
    { value: 'other', label: 'Other industries', group: null },
    { value: 'untagged', label: 'Not tagged yet', group: null },
  );
  return options;
}

function matchesIndustry(
  r: Recommended,
  industry: string,
  profile: readonly IndustryRow[],
): boolean {
  if (industry === 'all') return true;
  const fit = fitOf(r.company, profile);
  if (industry === 'other') return fit.kind === 'other';
  if (industry === 'untagged') return fit.kind === 'untagged';
  return r.company.naicsCode != null && industry === `code:${r.company.naicsCode}`;
}

/**
 * The rows to show: followed and denied companies only when asked for, then the filters, then the
 * sort. Most people you know is the contact count, then the name; best fit is the profile tier of
 * the company's tag (yours, similar, adjacent, other, not tagged), then the contact count, then the
 * name. It sorts a copy.
 */
export function applyRecommended(
  rows: readonly Recommended[],
  filters: RecommendedFilters,
  sort: RecommendedSort,
  profile: readonly IndustryRow[],
  show: { showFollowed: boolean; showDenied: boolean } = { showFollowed: false, showDenied: false },
): Recommended[] {
  const shown = rows.filter((r) => {
    const status = r.company.status;
    if (status === 'followed' && !show.showFollowed) return false;
    if (status === 'denied' && !show.showDenied) return false;
    if (filters.source === 'network' && !r.sources.network) return false;
    if (filters.source === 'suggested' && !r.sources.suggested) return false;
    if (filters.board !== 'any' && r.board !== filters.board) return false;
    return matchesIndustry(r, filters.industry, profile);
  });
  const byPeopleThenName = (a: Recommended, b: Recommended): number =>
    b.contactCount - a.contactCount || a.company.name.localeCompare(b.company.name);
  if (sort === 'people') return shown.sort(byPeopleThenName);
  return shown.sort(
    (a, b) =>
      fitRank(fitOf(a.company, profile)) - fitRank(fitOf(b.company, profile)) ||
      byPeopleThenName(a, b),
  );
}
