// The Recommended companies list's data (https://github.com/bgoleno/opportun/issues/300): one row
// for each company, from the network list and the suggestions, with the filters and the two sorts.
// Pure functions over what the page has already loaded: nothing here can make a request. Every name
// is made up.
import { describe, expect, it } from 'vitest';
import type { CompanyView, IndustryRow, NetworkCompany } from './companiesApi';
import {
  applyRecommended,
  fitOf,
  industryOptions,
  mergeRecommended,
  type RecommendedFilters,
} from './recommended';

const NOW = 1_700_000_000_000;

function company(over: Partial<CompanyView> & { id: string; name: string }): CompanyView {
  return {
    userId: 'u1',
    status: 'none',
    suggestionRationale: null,
    atsKind: null,
    atsRef: null,
    atsVerifiedAt: null,
    careersUrl: null,
    atsDetectPending: false,
    needsCareersUrl: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function inNetwork(c: CompanyView, count: number): NetworkCompany {
  return {
    company: c,
    board: c.atsKind == null ? 'not_checked' : c.atsKind === 'none' ? 'not_found' : 'found',
    contactCount: count,
    strongestStrength: null,
    contacts: Array.from({ length: count }, (_, i) => ({
      id: `${c.id}-p${i}`,
      name: `Person ${i}`,
      strength: null,
    })),
  };
}

const row = (
  code: string,
  title: string,
  tier: IndustryRow['tier'],
  over: Partial<IndustryRow> = {},
): IndustryRow => ({
  code,
  title,
  tier,
  source: 'resume',
  reason: `Why ${title}`,
  confirmed: true,
  ...over,
});

const SOFTWARE = row('5132', 'Software Publishers', 'core');
const DATA = row(
  '5182',
  'Computing Infrastructure Providers, Data Processing, Web Hosting',
  'similar',
);
const FREIGHT = row('4841', 'General Freight Trucking', 'adjacent');
const PROFILE = [SOFTWARE, DATA, FREIGHT];

const ALL: RecommendedFilters = { source: 'all', industry: 'all', board: 'any' };

describe('mergeRecommended: each company once, with where it came from', () => {
  it('a company in both lists is one row with both sources and its contacts', () => {
    const acme = company({ id: 'a', name: 'Acme', status: 'suggested' });
    const rows = mergeRecommended([inNetwork(acme, 3)], [acme]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sources: { network: true, suggested: true },
      contactCount: 3,
    });
  });

  it('a suggestion with no contact, and a network company that is not a suggestion', () => {
    const globex = company({ id: 'g', name: 'Globex', status: 'suggested' });
    const initech = company({ id: 'i', name: 'Initech' });
    const rows = mergeRecommended([inNetwork(initech, 2)], [globex]);
    expect(rows.map((r) => [r.company.name, r.sources, r.contactCount])).toEqual([
      ['Initech', { network: true, suggested: false }, 2],
      ['Globex', { network: false, suggested: true }, 0],
    ]);
  });

  it('a network company that is neither followed nor denied is listed; the others only on request', () => {
    const none = inNetwork(company({ id: '1', name: 'None Co' }), 1);
    const followed = inNetwork(company({ id: '2', name: 'Followed Co', status: 'followed' }), 1);
    const denied = inNetwork(company({ id: '3', name: 'Denied Co', status: 'denied' }), 1);
    const rows = mergeRecommended([none, followed, denied], []);
    const names = (opts: { showFollowed: boolean; showDenied: boolean }) =>
      applyRecommended(rows, ALL, 'people', [], opts).map((r) => r.company.name);
    expect(names({ showFollowed: false, showDenied: false })).toEqual(['None Co']);
    expect(names({ showFollowed: true, showDenied: false })).toEqual(['Followed Co', 'None Co']);
    expect(names({ showFollowed: false, showDenied: true })).toEqual(['Denied Co', 'None Co']);
  });
});

describe('fitOf and the industry options', () => {
  it('a tag in the profile has its tier and reason; another tag is other; none is not tagged', () => {
    expect(fitOf(company({ id: '1', name: 'A', naicsCode: '5132' }), PROFILE)).toEqual({
      kind: 'tier',
      tier: 'core',
      row: SOFTWARE,
    });
    expect(fitOf(company({ id: '2', name: 'B', naicsCode: '5415' }), PROFILE)).toEqual({
      kind: 'other',
    });
    expect(fitOf(company({ id: '3', name: 'C' }), PROFILE)).toEqual({ kind: 'untagged' });
    // Tried and not placed: it has no code, so it is not tagged.
    expect(fitOf(company({ id: '4', name: 'D', industryAt: NOW }), PROFILE)).toEqual({
      kind: 'untagged',
    });
  });

  it('the options are All, each confirmed row by tier, Other industries and Not tagged yet', () => {
    expect(industryOptions(PROFILE).map((o) => [o.group, o.label, o.value])).toEqual([
      [null, 'All industries', 'all'],
      ['Yours', SOFTWARE.title, 'code:5132'],
      ['Similar', DATA.title, 'code:5182'],
      ['Adjacent', FREIGHT.title, 'code:4841'],
      [null, 'Other industries', 'other'],
      [null, 'Not tagged yet', 'untagged'],
    ]);
    expect(industryOptions([]).map((o) => o.value)).toEqual(['all', 'other', 'untagged']);
  });
});

describe('the filters', () => {
  const a = company({
    id: 'a',
    name: 'Alpha',
    status: 'suggested',
    naicsCode: '5132',
    atsKind: 'ats_lever',
  });
  const b = company({ id: 'b', name: 'Bravo', naicsCode: '5415', atsKind: 'none' });
  const c = company({ id: 'c', name: 'Charlie', naicsCode: '4841' });
  const d = company({ id: 'd', name: 'Delta', status: 'suggested' });
  const rows = mergeRecommended([inNetwork(b, 4), inNetwork(c, 1), inNetwork(a, 2)], [a, d]);
  const names = (f: Partial<RecommendedFilters>) =>
    applyRecommended(rows, { ...ALL, ...f }, 'people', PROFILE).map((r) => r.company.name);

  it('by source: a company in both lists matches both', () => {
    expect(names({ source: 'network' })).toEqual(['Bravo', 'Alpha', 'Charlie']);
    expect(names({ source: 'suggested' })).toEqual(['Alpha', 'Delta']);
    expect(names({})).toEqual(['Bravo', 'Alpha', 'Charlie', 'Delta']);
  });

  it('by industry: a confirmed row, other industries, or not tagged yet', () => {
    expect(names({ industry: 'code:5132' })).toEqual(['Alpha']);
    expect(names({ industry: 'code:4841' })).toEqual(['Charlie']);
    expect(names({ industry: 'other' })).toEqual(['Bravo']);
    expect(names({ industry: 'untagged' })).toEqual(['Delta']);
  });

  it('by board: found, not checked yet, or no board found', () => {
    expect(names({ board: 'found' })).toEqual(['Alpha']);
    expect(names({ board: 'not_found' })).toEqual(['Bravo']);
    expect(names({ board: 'not_checked' })).toEqual(['Charlie', 'Delta']);
  });

  it('a board still being detected is not checked yet', () => {
    const pending = company({ id: 'p', name: 'Pending', atsDetectPending: true });
    const only = mergeRecommended([inNetwork(pending, 1)], []);
    expect(applyRecommended(only, { ...ALL, board: 'not_checked' }, 'people', []).length).toBe(1);
  });

  it('the filters combine', () => {
    expect(names({ source: 'network', board: 'not_checked' })).toEqual(['Charlie']);
    expect(names({ source: 'suggested', industry: 'untagged', board: 'not_checked' })).toEqual([
      'Delta',
    ]);
  });
});

describe('the two sorts', () => {
  const x = company({ id: 'x', name: 'Xylo', naicsCode: '4841' });
  const y = company({ id: 'y', name: 'Yarn', naicsCode: '5132' });
  const z = company({ id: 'z', name: 'Zed', naicsCode: '5415' });
  const w = company({ id: 'w', name: 'Walt' });
  const v = company({ id: 'v', name: 'Vera', naicsCode: '5182' });
  const u = company({ id: 'u', name: 'Uma', naicsCode: '5132' });
  const rows = mergeRecommended(
    [
      inNetwork(x, 5),
      inNetwork(y, 1),
      inNetwork(z, 9),
      inNetwork(w, 9),
      inNetwork(v, 2),
      inNetwork(u, 1),
    ],
    [],
  );
  const order = (sort: 'people' | 'fit') =>
    applyRecommended(rows, ALL, sort, PROFILE).map((r) => r.company.name);

  it('most people you know: contact count, then name', () => {
    expect(order('people')).toEqual(['Walt', 'Zed', 'Xylo', 'Vera', 'Uma', 'Yarn']);
  });

  it('best fit: yours, similar, adjacent, other, not tagged; then contact count, then name', () => {
    expect(order('fit')).toEqual(['Uma', 'Yarn', 'Vera', 'Xylo', 'Zed', 'Walt']);
  });

  it('sorts a copy: the rows it was given keep their order', () => {
    const before = rows.map((r) => r.company.name);
    order('fit');
    expect(rows.map((r) => r.company.name)).toEqual(before);
  });
});
