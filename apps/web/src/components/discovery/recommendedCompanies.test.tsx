// The Recommended companies list on the Companies tab (https://github.com/bgoleno/opportun/issues/300,
// slice b of #222; it replaces "In your network" from #216 and "Suggested companies"): one row for
// each company, the source badges, the board chip, the reason, the contacts' names only behind the
// "You know N people" disclosure, Follow and Deny as they were, the source, industry and board
// filters, the two sorts, and nothing requested to build, filter or sort it. Every name is made up.
import { naicsTitle } from '@opportun/core';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { CompaniesManager } from './CompaniesManager';
import type { CompanyView, IndustryRow, NetworkCompany } from './companiesApi';
import { closeSplit, knowLine } from './RecommendedRow';

const NOW = Date.now();

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
    boardProbedAt: null,
    boardOpenJobs: null,
    boardPrefilterMatches: null,
    boardProbePending: false,
    ...over,
  };
}

const CONTOSO: NetworkCompany = {
  company: company({
    id: 'n-1',
    name: 'Contoso',
    domain: 'contoso.example',
    status: 'followed',
    atsKind: 'ats_lever',
    atsRef: 'contoso',
    atsVerifiedAt: NOW,
  }),
  board: 'found',
  contactCount: 3,
  strongestStrength: 3,
  contacts: [
    { id: 'p-1', name: 'Riley Sample', strength: 3 },
    { id: 'p-2', name: 'Morgan Example', strength: 1 },
    { id: 'p-3', name: 'Casey Placeholder', strength: null },
  ],
};
const NORTHWIND: NetworkCompany = {
  company: company({
    id: 'n-2',
    name: 'Northwind Traders',
    atsKind: 'none',
    atsVerifiedAt: NOW,
    naicsCode: '5415',
    industrySource: 'ai',
    industryAt: NOW,
  }),
  board: 'not_found',
  contactCount: 1,
  strongestStrength: 2,
  contacts: [{ id: 'p-4', name: 'Jordan Test', strength: 2 }],
};
const TAILSPIN: NetworkCompany = {
  company: company({ id: 'n-3', name: 'Tailspin Toys' }),
  board: 'not_checked',
  contactCount: 1,
  strongestStrength: null,
  contacts: [{ id: 'p-5', name: 'Avery Demo', strength: null }],
};
const INITECH: NetworkCompany = {
  company: company({ id: 'n-4', name: 'Initech', status: 'denied' }),
  board: 'not_checked',
  contactCount: 2,
  strongestStrength: 1,
  contacts: [
    { id: 'p-6', name: 'Quinn Mock', strength: 1 },
    { id: 'p-7', name: 'Sam Fixture', strength: 1 },
  ],
};
/** A suggestion nobody in the network works at. */
const ACME = company({
  id: 's-1',
  name: 'Acme',
  status: 'suggested',
  suggestionRationale: 'Similar to companies in your pipeline.',
  atsKind: 'ats_greenhouse',
  atsRef: 'acme',
  atsVerifiedAt: NOW,
  naicsCode: '5132',
  industrySource: 'ai',
  industryAt: NOW,
});
/** A suggestion that is also somebody the user knows: one row, both badges. */
const GLOBEX_SUGGESTED = company({
  id: 's-2',
  name: 'Globex',
  status: 'suggested',
  suggestionRationale: 'Hires for the roles you saved.',
  naicsCode: '4841',
  industrySource: 'ai',
  industryAt: NOW,
});
const GLOBEX: NetworkCompany = {
  company: GLOBEX_SUGGESTED,
  board: 'not_checked',
  contactCount: 2,
  strongestStrength: 1,
  contacts: [
    { id: 'p-8', name: 'Drew Stub', strength: 1 },
    { id: 'p-9', name: 'Lee Sketch', strength: null },
  ],
};

const SOFTWARE: IndustryRow = {
  code: '5132',
  title: 'Software Publishers',
  tier: 'core',
  source: 'resume',
  reason: 'Your resume is mostly platform work.',
  confirmed: true,
};
const FREIGHT: IndustryRow = {
  code: '4841',
  title: 'General Freight Trucking',
  tier: 'adjacent',
  source: 'target',
  reason: 'A customer industry of your core one.',
  confirmed: true,
};
const UNCONFIRMED: IndustryRow = {
  code: '5182',
  title: 'Computing Infrastructure Providers, Data Processing, Web Hosting',
  tier: 'similar',
  source: 'resume',
  reason: 'Not confirmed yet.',
  confirmed: false,
};

/** Every request a page build may make: nothing else, and nothing that is not a read. */
const READS = new Set([
  '/discovery/network-companies',
  '/companies/suggestions',
  '/companies',
  '/discovery/industry-profile',
  '/discovery/sources',
  '/discovery/cost-figures',
  '/discovery/prefilter/recall',
  '/ai/discovery-budget',
]);

function routes(extra: Record<string, unknown> = {}) {
  return mockApi({
    'GET /discovery/network-companies': {
      items: [CONTOSO, INITECH, NORTHWIND, TAILSPIN, GLOBEX],
    },
    'GET /companies/suggestions': { items: [ACME, GLOBEX_SUGGESTED], total: 2 },
    'GET /companies': { items: [], total: 0 },
    'GET /discovery/industry-profile': { items: [SOFTWARE, FREIGHT, UNCONFIRMED] },
    'GET /discovery/sources': { items: [], total: 0 },
    'GET /discovery/cost-figures': { rank: [], sources: [] },
    'GET /discovery/prefilter/recall': RECALL_ON,
    'GET /ai/discovery-budget': { dailyUsd: 1, spentTodayUsd: 0, waiting: 0, perTaskDailyUsd: 5 },
    ...extra,
  });
}

/** One of the filter controls: "Industry" is also on the Where to look panel, above the list. */
const control = (label: string) =>
  within(screen.getByRole('group', { name: 'Filter and sort the companies' })).getByLabelText(
    label,
  );
const RECALL_ON = {
  positives: 40,
  kept: 40,
  recall: 1,
  on: true,
  neededRecall: 0.95,
  neededPositives: 20,
  judged: 100,
  filtered: 60,
};

const list = async () => await screen.findByRole('list', { name: 'Recommended companies' });
const rowTitles = (l: HTMLElement) =>
  [...l.children].map((li) => li.querySelector('[data-company-name]')?.textContent);

describe('#300: one list replaces In your network and Suggested companies', () => {
  it('the old two lists are gone, Where to look is at the top, and the list is named', async () => {
    routes();
    renderWithProviders(<CompaniesManager />);
    await list();
    expect(screen.queryByRole('list', { name: 'Companies in your network' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Suggested companies' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Recommended companies' })).toBeInTheDocument();
    // Where to look comes before the list in the page.
    const where = screen.getByText('Where to look');
    const heading = screen.getByRole('heading', { name: 'Recommended companies' });
    expect(where.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('each company is one row, even in both lists; followed and denied ones are not in it', async () => {
    routes();
    renderWithProviders(<CompaniesManager />);
    const l = await list();
    await within(l).findByRole('listitem', { name: 'Globex' });
    expect(rowTitles(l).sort()).toEqual(
      ['Acme', 'Globex', 'Northwind Traders', 'Tailspin Toys'].sort(),
    );
    expect(within(l).getAllByRole('listitem', { name: 'Globex' })).toHaveLength(1);
  });

  it('the source badges: in your network, AI suggested, or both', async () => {
    routes();
    renderWithProviders(<CompaniesManager />);
    const l = await list();
    const acme = await within(l).findByRole('listitem', { name: 'Acme' });
    expect(within(acme).getByText('AI suggested')).toBeInTheDocument();
    expect(within(acme).queryByText('In your network')).toBeNull();
    const tailspin = within(l).getByRole('listitem', { name: 'Tailspin Toys' });
    expect(within(tailspin).getByText('In your network')).toBeInTheDocument();
    expect(within(tailspin).queryByText('AI suggested')).toBeNull();
    const globex = within(l).getByRole('listitem', { name: 'Globex' });
    expect(within(globex).getByText('In your network')).toBeInTheDocument();
    expect(within(globex).getByText('AI suggested')).toBeInTheDocument();
  });

  it('the board chip: found with its kind, not found, or not checked yet', async () => {
    routes();
    renderWithProviders(<CompaniesManager />);
    const l = await list();
    expect(await within(l).findByRole('listitem', { name: 'Acme' })).toHaveTextContent(
      'Greenhouse: acme',
    );
    expect(within(l).getByRole('listitem', { name: 'Northwind Traders' })).toHaveTextContent(
      'No board found',
    );
    expect(within(l).getByRole('listitem', { name: 'Tailspin Toys' })).toHaveTextContent(
      'Not checked yet',
    );
  });

  it('the reason: a suggestion says why; a tagged company says its industry, tier and reason', async () => {
    routes();
    renderWithProviders(<CompaniesManager />);
    const l = await list();
    const acme = await within(l).findByRole('listitem', { name: 'Acme' });
    // A suggestion: its own rationale, as before.
    expect(acme).toHaveTextContent('Why: Similar to companies in your pipeline.');
    // A tag in the confirmed profile: the industry's title, the tier and the profile row's reason.
    expect(acme).toHaveTextContent(
      'Industry: Software Publishers (yours): Your resume is mostly platform work.',
    );
    expect(within(l).getByRole('listitem', { name: 'Globex' })).toHaveTextContent(
      'Industry: General Freight Trucking (adjacent): A customer industry of your core one.',
    );
    // A tag outside the profile: the title only, with Other industries.
    expect(within(l).getByRole('listitem', { name: 'Northwind Traders' })).toHaveTextContent(
      `Industry: ${naicsTitle('5415')} (other industries)`,
    );
    // Not tagged yet is said, and an unconfirmed profile row gives no tier or reason.
    expect(within(l).getByRole('listitem', { name: 'Tailspin Toys' })).toHaveTextContent(
      'Industry: not tagged yet',
    );
  });

  it('there is no description: a network company says how many people you know, and nothing more', async () => {
    routes();
    renderWithProviders(<CompaniesManager />);
    const l = await list();
    const tailspin = await within(l).findByRole('listitem', { name: 'Tailspin Toys' });
    expect(tailspin).toHaveTextContent('You know 1 person here');
    expect(within(l).queryByText(/description/i)).toBeNull();
  });
});

describe('#300: the contacts stay behind the disclosure', () => {
  it('names show only behind the "You know N people" disclosure', async () => {
    const user = userEvent.setup();
    routes();
    renderWithProviders(<CompaniesManager />);
    const globex = await within(await list()).findByRole('listitem', { name: 'Globex' });
    const details = [...globex.querySelectorAll('details')].find((d) =>
      d.querySelector('summary')?.textContent?.includes('You know'),
    )!;
    expect(details.open).toBe(false);
    const summary = details.querySelector('summary')!;
    expect(summary).toHaveTextContent('You know 2 people here');
    for (const name of ['Drew Stub', 'Lee Sketch']) {
      expect(summary).not.toHaveTextContent(name);
      expect(within(details).getByText(name, { exact: false })).toBeInTheDocument();
    }
    const outside = [...globex.children].filter((el) => el !== details && !el.contains(details));
    expect(outside.map((el) => el.textContent).join(' ')).not.toMatch(/Drew|Lee/);
    await user.click(summary);
    expect(details.open).toBe(true);
    expect(
      within(details).getByRole('list', { name: 'People you know at Globex' }),
    ).toHaveTextContent('Drew Stub · Acquaintance');
  });

  it('a suggestion nobody here works at has no disclosure', async () => {
    routes();
    renderWithProviders(<CompaniesManager />);
    const acme = await within(await list()).findByRole('listitem', { name: 'Acme' });
    expect(within(acme).queryByText(/You know/)).toBeNull();
  });
});

describe('#300: Follow and Deny do what they did', () => {
  it('Follow on a suggestion accepts it; on a network company it follows it', async () => {
    const user = userEvent.setup();
    const { calls } = routes({
      'POST /companies/s-1/accept': { ...ACME, status: 'followed' },
      'POST /companies/n-2/follow': { ...NORTHWIND.company, status: 'followed' },
      'POST /companies/s-2/accept': { ...GLOBEX_SUGGESTED, status: 'followed' },
    });
    renderWithProviders(<CompaniesManager />);
    const l = await list();
    await user.click(
      within(await within(l).findByRole('listitem', { name: 'Acme' })).getByRole('button', {
        name: 'Follow Acme',
      }),
    );
    await user.click(
      within(within(l).getByRole('listitem', { name: 'Northwind Traders' })).getByRole('button', {
        name: 'Follow Northwind Traders and add careers page',
      }),
    );
    // A suggestion that is also in the network is still a suggestion: accept, not follow.
    await user.click(
      within(within(l).getByRole('listitem', { name: 'Globex' })).getByRole('button', {
        name: 'Follow Globex',
      }),
    );
    await waitFor(() =>
      expect(calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`)).toEqual([
        'POST /companies/s-1/accept',
        'POST /companies/n-2/follow',
        'POST /companies/s-2/accept',
      ]),
    );
  });

  it('a refused Follow on a company denied meanwhile explains', async () => {
    const user = userEvent.setup();
    routes({
      'POST /companies/n-2/follow': () => ({
        status: 409,
        body: { error: { code: 'company_denied', message: 'denied' } },
      }),
    });
    renderWithProviders(<CompaniesManager />);
    const row = await within(await list()).findByRole('listitem', { name: 'Northwind Traders' });
    await user.click(
      within(row).getByRole('button', { name: 'Follow Northwind Traders and add careers page' }),
    );
    expect(
      await screen.findByText('That company is denied. Undo the denial first.'),
    ).toBeInTheDocument();
  });

  it('Deny on a suggestion denies it; on a network company it sets the status', async () => {
    const user = userEvent.setup();
    const { calls } = routes({
      'POST /companies/s-1/deny': { ...ACME, status: 'denied' },
      'PATCH /companies/n-3': { ...TAILSPIN.company, status: 'denied' },
    });
    renderWithProviders(<CompaniesManager />);
    const l = await list();
    await user.click(
      within(await within(l).findByRole('listitem', { name: 'Acme' })).getByRole('button', {
        name: 'Deny Acme',
      }),
    );
    await user.click(
      within(within(l).getByRole('listitem', { name: 'Tailspin Toys' })).getByRole('button', {
        name: 'Deny Tailspin Toys',
      }),
    );
    await waitFor(() =>
      expect(calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`)).toEqual([
        'POST /companies/s-1/deny',
        'PATCH /companies/n-3',
      ]),
    );
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'denied' });
  });

  it('a 409 not_suggested on a suggestion restores it and explains', async () => {
    const user = userEvent.setup();
    routes({
      'POST /companies/s-1/accept': () => ({
        status: 409,
        body: { error: { code: 'not_suggested', message: 'x' } },
      }),
    });
    renderWithProviders(<CompaniesManager />);
    const l = await list();
    await user.click(
      within(await within(l).findByRole('listitem', { name: 'Acme' })).getByRole('button', {
        name: 'Follow Acme',
      }),
    );
    expect(
      await screen.findByText('That company is no longer a pending suggestion.'),
    ).toBeInTheDocument();
    expect(await within(l).findByRole('listitem', { name: 'Acme' })).toBeInTheDocument();
  });
});

describe('#300: followed and denied companies only under their toggles', () => {
  it('a followed one appears under "Show followed" with Following and no Follow button', async () => {
    const user = userEvent.setup();
    routes();
    renderWithProviders(<CompaniesManager />);
    const l = await list();
    await within(l).findByRole('listitem', { name: 'Acme' });
    expect(within(l).queryByRole('listitem', { name: 'Contoso' })).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'Show followed' }));
    const contoso = await within(l).findByRole('listitem', { name: 'Contoso' });
    expect(within(contoso).getByText('Following')).toBeInTheDocument();
    expect(contoso).toHaveTextContent('Lever: contoso');
    expect(within(contoso).queryByRole('button', { name: 'Follow Contoso' })).toBeNull();
  });

  it('a denied one appears under "Show denied", and can be undone', async () => {
    const user = userEvent.setup();
    const { calls } = routes({ 'PATCH /companies/n-4': { ...INITECH.company, status: 'none' } });
    renderWithProviders(<CompaniesManager />);
    const l = await list();
    await within(l).findByRole('listitem', { name: 'Acme' });
    expect(within(l).queryByRole('listitem', { name: 'Initech' })).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'Show denied' }));
    const initech = await within(l).findByRole('listitem', { name: 'Initech' });
    expect(within(initech).getByText('Denied')).toBeInTheDocument();
    expect(within(initech).queryByRole('button', { name: 'Follow Initech' })).toBeNull();
    await user.click(
      within(initech).getByRole('button', {
        name: 'Undo denying Initech in Recommended companies',
      }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'none' }),
    );
  });
});

describe('#300: the filters and the sorts', () => {
  /** The rows on screen, once the first load has finished. */
  async function loaded() {
    const l = await list();
    await within(l).findByRole('listitem', { name: 'Acme' });
    return l;
  }
  const titles = () => rowTitles(screen.getByRole('list', { name: 'Recommended companies' }));

  it('sorts by most people you know by default, then by best fit', async () => {
    const user = userEvent.setup();
    routes();
    renderWithProviders(<CompaniesManager />);
    await loaded();
    // Globex knows 2, then 1 each by name; Acme knows nobody.
    expect(titles()).toEqual(['Globex', 'Northwind Traders', 'Tailspin Toys', 'Acme']);
    await user.selectOptions(control('Sort by'), 'fit');
    // Yours (Acme), adjacent (Globex), other (Northwind Traders), not tagged (Tailspin Toys).
    expect(titles()).toEqual(['Acme', 'Globex', 'Northwind Traders', 'Tailspin Toys']);
  });

  it('filters by source: a company in both lists matches both', async () => {
    const user = userEvent.setup();
    routes();
    renderWithProviders(<CompaniesManager />);
    await loaded();
    await user.selectOptions(control('Source'), 'network');
    expect(titles()).toEqual(['Globex', 'Northwind Traders', 'Tailspin Toys']);
    await user.selectOptions(control('Source'), 'suggested');
    expect(titles()).toEqual(['Globex', 'Acme']);
  });

  it('filters by industry: each confirmed row by tier, other industries and not tagged yet', async () => {
    const user = userEvent.setup();
    routes();
    renderWithProviders(<CompaniesManager />);
    await loaded();
    const industry = control('Industry');
    // Only confirmed rows are offered, by tier.
    const options = within(industry)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual([
      'All industries',
      'Software Publishers',
      'General Freight Trucking',
      'Other industries',
      'Not tagged yet',
    ]);
    expect(within(industry).getByRole('group', { name: 'Yours' })).toBeInTheDocument();
    expect(within(industry).getByRole('group', { name: 'Adjacent' })).toBeInTheDocument();
    await user.selectOptions(industry, 'code:5132');
    expect(titles()).toEqual(['Acme']);
    await user.selectOptions(industry, 'other');
    expect(titles()).toEqual(['Northwind Traders']);
    await user.selectOptions(industry, 'untagged');
    expect(titles()).toEqual(['Tailspin Toys']);
  });

  it('filters by board: found, not checked yet, no board found', async () => {
    const user = userEvent.setup();
    routes();
    renderWithProviders(<CompaniesManager />);
    await loaded();
    const board = control('Board');
    await user.selectOptions(board, 'found');
    expect(titles()).toEqual(['Acme']);
    await user.selectOptions(board, 'not_found');
    expect(titles()).toEqual(['Northwind Traders']);
    await user.selectOptions(board, 'not_checked');
    expect(titles()).toEqual(['Globex', 'Tailspin Toys']);
  });

  it('says how many it shows, politely, and what to do when a filter hides everything', async () => {
    const user = userEvent.setup();
    routes();
    renderWithProviders(<CompaniesManager />);
    await loaded();
    const status = screen.getByRole('status', { name: 'Companies shown' });
    expect(status).toHaveTextContent('4 companies');
    expect(status).toHaveAttribute('aria-live', 'polite');
    await user.selectOptions(control('Industry'), 'code:5132');
    expect(status).toHaveTextContent('1 company');
    await user.selectOptions(control('Board'), 'not_found');
    expect(status).toHaveTextContent('No company matches these filters.');
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(status).toHaveTextContent('4 companies');
    expect(titles()).toHaveLength(4);
  });
});

describe('#300: nothing is requested to build, filter or sort the list', () => {
  it('only the reads the page needs, and no new request for a filter, a sort or a toggle', async () => {
    const user = userEvent.setup();
    const { calls } = routes();
    renderWithProviders(<CompaniesManager />);
    const l = await list();
    await within(l).findByRole('listitem', { name: 'Acme' });
    await waitFor(() =>
      expect(calls.some((c) => c.path === '/discovery/industry-profile')).toBe(true),
    );
    // Every request so far is one of the reads the page lists, and a GET: no AI endpoint, no
    // board detection, no probe.
    expect(calls.every((c) => c.method === 'GET' && READS.has(c.path))).toBe(true);
    const before = calls.length;

    await user.selectOptions(control('Source'), 'network');
    await user.selectOptions(control('Industry'), 'code:5132');
    await user.selectOptions(control('Board'), 'found');
    await user.selectOptions(control('Sort by'), 'fit');
    await user.click(screen.getByRole('checkbox', { name: 'Show followed' }));
    await user.click(screen.getByRole('checkbox', { name: 'Show denied' }));
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(calls).toHaveLength(before);
  });
});

describe('#301: Check board, only on the click', () => {
  const checkButton = (row: HTMLElement, name: string) =>
    within(row).queryByRole('button', { name: `Check board for ${name}` });

  it('is offered on a company never checked, and nowhere else', async () => {
    const user = userEvent.setup();
    routes();
    renderWithProviders(<CompaniesManager />);
    const l = await list();
    await within(l).findByRole('listitem', { name: 'Acme' });
    // Never checked: a network company and a suggestion.
    expect(
      checkButton(within(l).getByRole('listitem', { name: 'Tailspin Toys' }), 'Tailspin Toys'),
    ).not.toBeNull();
    expect(
      checkButton(within(l).getByRole('listitem', { name: 'Globex' }), 'Globex'),
    ).not.toBeNull();
    // A board found, and no board found.
    expect(checkButton(within(l).getByRole('listitem', { name: 'Acme' }), 'Acme')).toBeNull();
    expect(
      checkButton(
        within(l).getByRole('listitem', { name: 'Northwind Traders' }),
        'Northwind Traders',
      ),
    ).toBeNull();
    // A followed company has no use for it.
    await user.click(screen.getByRole('checkbox', { name: 'Show followed' }));
    expect(
      checkButton(await within(l).findByRole('listitem', { name: 'Contoso' }), 'Contoso'),
    ).toBeNull();
  });

  it('a click asks for that one company, and the row says it is checking', async () => {
    const user = userEvent.setup();
    let asked = false;
    const { calls } = routes({
      'POST /companies/n-3/check-board': () => {
        asked = true;
        return { status: 202, body: { jobId: 'job-1' } };
      },
      'GET /discovery/network-companies': () => ({
        items: [
          CONTOSO,
          INITECH,
          NORTHWIND,
          asked
            ? { ...TAILSPIN, company: { ...TAILSPIN.company, boardProbePending: true } }
            : TAILSPIN,
          GLOBEX,
        ],
      }),
    });
    renderWithProviders(<CompaniesManager />);
    const l = await list();
    const row = await within(l).findByRole('listitem', { name: 'Tailspin Toys' });
    // Nothing has been asked for by showing the list: a build asks for no check.
    expect(calls.some((c) => c.method !== 'GET')).toBe(false);
    await user.click(within(row).getByRole('button', { name: 'Check board for Tailspin Toys' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`)).toEqual([
        'POST /companies/n-3/check-board',
      ]),
    );
    expect(await within(row).findByText('Checking board...')).toBeInTheDocument();
    expect(checkButtonGone(row)).toBe(true);
    // No other company was asked about.
    expect(calls.filter((c) => c.path.endsWith('/check-board'))).toHaveLength(1);
  });

  const checkButtonGone = (row: HTMLElement) =>
    within(row).queryByRole('button', { name: /^Check board for / }) === null;

  it('says why a company cannot be checked, and when the hour is up', async () => {
    const user = userEvent.setup();
    routes({
      'POST /companies/n-3/check-board': () => ({
        status: 409,
        body: { error: { code: 'already_checked' } },
      }),
      'POST /companies/s-2/check-board': () => ({
        status: 429,
        headers: { 'retry-after': '1380' },
        body: { error: { code: 'rate_limited', reason: 'per_user', max: 30, windowMinutes: 60 } },
      }),
    });
    renderWithProviders(<CompaniesManager />);
    const l = await list();
    await user.click(
      within(await within(l).findByRole('listitem', { name: 'Tailspin Toys' })).getByRole(
        'button',
        {
          name: 'Check board for Tailspin Toys',
        },
      ),
    );
    expect(await screen.findByText('That company was already checked.')).toBeInTheDocument();
    await user.click(
      within(within(l).getByRole('listitem', { name: 'Globex' })).getByRole('button', {
        name: 'Check board for Globex',
      }),
    );
    expect(
      await screen.findByText(
        'You can check up to 30 boards an hour. Try again in about 23 minutes.',
      ),
    ).toBeInTheDocument();
  });
});

describe('#301: the estimate line', () => {
  const PROBED = {
    ...ACME,
    boardProbedAt: NOW,
    boardOpenJobs: 200,
    boardPrefilterMatches: 40,
  };
  const figures = (avgCostUsd: number | null, sources: unknown[] = []) => ({
    rank: [
      {
        days: 30,
        calls: avgCostUsd === null ? 0 : 10,
        errors: 0,
        inputTokens: null,
        outputTokens: null,
        avgCostUsd,
        totalCostUsd: 0,
      },
    ],
    sources,
  });
  const withProbed = (extra: Record<string, unknown> = {}) =>
    routes({
      'GET /companies/suggestions': { items: [PROBED, GLOBEX_SUGGESTED], total: 2 },
      'GET /discovery/cost-figures': figures(0.02),
      ...extra,
    });

  it('a probed company: new a day, the cost a day, and the first run, at the 30-day average', async () => {
    withProbed();
    renderWithProviders(<CompaniesManager />);
    const acme = await within(await list()).findByRole('listitem', { name: 'Acme' });
    expect(
      await within(acme).findByText('about 4 new a day, est. $0.02 a day; first run 25, $0.50'),
    ).toBeInTheDocument();
  });

  it('with the pre-filter not acting, everything is ranked', async () => {
    withProbed({ 'GET /discovery/prefilter/recall': { ...RECALL_ON, on: false } });
    renderWithProviders(<CompaniesManager />);
    const acme = await within(await list()).findByRole('listitem', { name: 'Acme' });
    // 4 new a day, all of them ranked: 4 times $0.02.
    expect(
      await within(acme).findByText('about 4 new a day, est. $0.08 a day; first run 25, $0.50'),
    ).toBeInTheDocument();
  });

  it('shows no estimate until the cost figure and the pre-filter have been read, then the right one', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    withProbed({
      // The recall answer is late: until it comes the pre-filter would count as off, and the
      // first line shown (everything ranked, $0.08 a day) would be the wrong one.
      'GET /discovery/prefilter/recall': async () => {
        await held;
        return RECALL_ON;
      },
    });
    renderWithProviders(<CompaniesManager />);
    const acme = await within(await list()).findByRole('listitem', { name: 'Acme' });
    await within(acme).findByText('Acme');
    expect(within(acme).queryByText(/new a day/)).toBeNull();
    release();
    expect(
      await within(acme).findByText('about 4 new a day, est. $0.02 a day; first run 25, $0.50'),
    ).toBeInTheDocument();
  });

  it('with no rank call in 30 days it says the cost is not known, and keeps the counts', async () => {
    withProbed({ 'GET /discovery/cost-figures': figures(null) });
    renderWithProviders(<CompaniesManager />);
    const acme = await within(await list()).findByRole('listitem', { name: 'Acme' });
    expect(
      await within(acme).findByText(
        'about 4 new a day; first run 25 postings (cost not known yet)',
      ),
    ).toBeInTheDocument();
  });

  it('a company not probed, or with no board found, has no estimate line', async () => {
    withProbed();
    renderWithProviders(<CompaniesManager />);
    const l = await list();
    await within(l).findByText(/^about 4 new a day/);
    for (const name of ['Globex', 'Tailspin Toys', 'Northwind Traders']) {
      expect(within(within(l).getByRole('listitem', { name })).queryByText(/new a day/)).toBeNull();
    }
    // It keeps Follow, labelled for what the user will need to do next.
    const northwind = within(l).getByRole('listitem', { name: 'Northwind Traders' });
    expect(
      within(northwind).getByRole('button', {
        name: 'Follow Northwind Traders and add careers page',
      }),
    ).toHaveTextContent('Follow and add careers page');
  });

  it('a followed company: the daily part only, from its own runs once it has 14 days of them', async () => {
    const user = userEvent.setup();
    withProbed({
      'GET /discovery/sources': {
        items: [{ id: 's-9', companyId: 'n-1', kind: 'ats_lever', prefilterEnabled: true }],
        total: 1,
      },
      'GET /discovery/cost-figures': figures(0.02, [
        {
          sourceId: 's-9',
          kind: 'ats_lever',
          openJobs: 300,
          newPerDay: 9,
          days: 14,
          rankCallsPerDay: 2,
          costPerDayUsd: 0.04,
          belowCut: 0,
          belowCutCostUsd: null,
        },
      ]),
      'GET /discovery/network-companies': {
        items: [
          {
            ...CONTOSO,
            company: {
              ...CONTOSO.company,
              boardProbedAt: NOW,
              boardOpenJobs: 200,
              boardPrefilterMatches: 40,
            },
          },
          NORTHWIND,
          TAILSPIN,
          GLOBEX,
        ],
      },
    });
    renderWithProviders(<CompaniesManager />);
    const l = await list();
    await user.click(await screen.findByRole('checkbox', { name: 'Show followed' }));
    const contoso = await within(l).findByRole('listitem', { name: 'Contoso' });
    expect(
      await within(contoso).findByText('about 9 new a day, est. $0.04 a day'),
    ).toBeInTheDocument();
    expect(within(contoso).queryByText(/first run/)).toBeNull();
  });
});

describe('#300: for the keyboard and a screen reader', () => {
  it('the controls have names, are one group, and the rows name their company', async () => {
    routes();
    renderWithProviders(<CompaniesManager />);
    const l = await list();
    await within(l).findByRole('listitem', { name: 'Acme' });
    const group = screen.getByRole('group', { name: 'Filter and sort the companies' });
    for (const label of ['Source', 'Industry', 'Board', 'Sort by']) {
      expect(within(group).getByLabelText(label)).toBeInTheDocument();
    }
    for (const label of ['Show followed', 'Show denied']) {
      expect(within(group).getByRole('checkbox', { name: label })).toBeInTheDocument();
    }
    for (const li of l.children) {
      expect(li.getAttribute('aria-labelledby') ?? li.getAttribute('aria-label')).toBeTruthy();
    }
    // Each row's buttons name the company, so a list of Follow buttons is not a list of "Follow".
    expect(within(l).getAllByRole('button', { name: /^Follow / })).toHaveLength(4);
  });

  it('every control is reached by the Tab key, in the order they are on screen', async () => {
    const user = userEvent.setup();
    routes();
    renderWithProviders(<CompaniesManager />);
    const l = await list();
    await within(l).findByRole('listitem', { name: 'Acme' });
    const first = control('Source');
    first.focus();
    const order = ['Source', 'Industry', 'Board', 'Sort by'];
    for (const label of order.slice(1)) {
      await user.tab();
      expect(control(label)).toHaveFocus();
    }
  });
});

describe('#300: the empty states, and hostile text', () => {
  it('says so when there is nothing to recommend yet', async () => {
    routes({
      'GET /discovery/network-companies': { items: [] },
      'GET /companies/suggestions': { items: [], total: 0 },
    });
    renderWithProviders(<CompaniesManager />);
    expect(
      await screen.findByText(
        "None yet. Suggestions appear as your pipeline grows. Add your contacts' current companies under Network to see them here.",
      ),
    ).toBeInTheDocument();
  });

  it('renders a hostile company, rationale or contact name inert, as text', async () => {
    const HOSTILE = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
    routes({
      'GET /discovery/network-companies': {
        items: [
          {
            ...TAILSPIN,
            company: {
              ...TAILSPIN.company,
              name: 'Evil <b>Corp</b>',
              status: 'suggested',
              suggestionRationale: `**bold** [x](javascript:alert(1)) ${HOSTILE}`,
            },
            contacts: [{ id: 'p-x', name: HOSTILE, strength: 3 }],
          },
        ],
      },
      'GET /companies/suggestions': { items: [], total: 0 },
    });
    renderWithProviders(<CompaniesManager />);
    const row = await within(await list()).findByRole('listitem', { name: 'Evil <b>Corp</b>' });
    expect(row.querySelector('script, img, b, strong, a')).toBeNull();
    expect(row).toHaveTextContent(HOSTILE);
    expect(row).toHaveTextContent(`**bold** [x](javascript:alert(1)) ${HOSTILE}`);
    expect((window as unknown as { __pwned?: unknown }).__pwned).toBeUndefined();
  });
});

describe('#216: the disclosure line', () => {
  it('counts people and close contacts', () => {
    expect(knowLine(1)).toBe('You know 1 person here');
    expect(knowLine(6)).toBe('You know 6 people here');
    const p = (strength: number | null, n: number) => ({ id: `p${n}`, name: `P${n}`, strength });
    expect(closeSplit([p(3, 1), p(3, 2), p(1, 3), p(null, 4)])).toBe('(2 close, 2 others)');
    expect(closeSplit([p(3, 1), p(2, 2)])).toBe('(1 close, 1 other)');
    expect(closeSplit([p(3, 1)])).toBe('(1 close)');
    expect(closeSplit([p(2, 1), p(null, 2)])).toBe('');
  });
});

describe('#296: a board found by guessing names shows its address', () => {
  it('a candidate with a Greenhouse board links to it, in a new tab', async () => {
    routes();
    renderWithProviders(<CompaniesManager />);
    const l = await list();
    const row = await within(l).findByRole('listitem', { name: 'Acme' });
    const link = within(row).getByRole('link', {
      name: 'Board for Acme: boards.greenhouse.io/acme (opens in a new tab)',
    });
    expect(link).toHaveAttribute('href', 'https://boards.greenhouse.io/acme');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('no board: no address, and the row asks for nothing more than it did before', async () => {
    routes();
    renderWithProviders(<CompaniesManager />);
    const l = await list();
    const row = await within(l).findByRole('listitem', { name: 'Northwind Traders' });
    expect(row.querySelector('[data-board-address]')).toBeNull();
    // What a company with no board has shown since #300: Follow says it will ask for the careers
    // page, and nothing on the row asks for it before a Follow.
    expect(
      within(row).getByRole('button', { name: 'Follow Northwind Traders and add careers page' }),
    ).toBeInTheDocument();
    expect(within(row).queryByRole('textbox')).toBeNull();
    expect(within(row).queryByText(/careers URL/i)).toBeNull();
  });
});
