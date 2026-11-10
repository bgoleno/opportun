// Selecting Recommended companies, the budget rail and the confirm before a large follow
// (https://github.com/bgoleno/opportun/issues/302, N5b-d of #222, with tl's answers there): row
// checkboxes and the selection bar's running total, the rail of today's budget, a confirm with the
// figures itemised before a follow that is large or would pass the budget, and the keyboard
// (j and k move, Space checks, f follows, x denies). Every name is made up.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { CompaniesManager } from './CompaniesManager';
import type { CompanyView, NetworkCompany } from './companiesApi';

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

const probed = { atsKind: 'ats_greenhouse', atsVerifiedAt: NOW, boardProbedAt: NOW };
/** 200 open jobs, 40 of them match: 4 new a day, a first run of 25 calls. */
const ACME = company({
  id: 's-1',
  name: 'Acme',
  status: 'suggested',
  ...probed,
  atsRef: 'acme',
  boardOpenJobs: 200,
  boardPrefilterMatches: 40,
});
/** The same figures, for a second row. */
const BRAVO = company({
  id: 's-2',
  name: 'Bravo',
  status: 'suggested',
  ...probed,
  atsRef: 'bravo',
  boardOpenJobs: 200,
  boardPrefilterMatches: 40,
});
/** A network company, probed with the same figures. */
const CHARLIE: NetworkCompany = {
  company: company({
    id: 'n-1',
    name: 'Charlie',
    ...probed,
    atsRef: 'charlie',
    boardOpenJobs: 200,
    boardPrefilterMatches: 40,
  }),
  board: 'found',
  contactCount: 2,
  strongestStrength: null,
  contacts: [
    { id: 'p-1', name: 'Sam Stub', strength: null },
    { id: 'p-2', name: 'Lee Sketch', strength: null },
  ],
};
/** Never checked: no estimate. */
const DELTA: NetworkCompany = {
  company: company({ id: 'n-2', name: 'Delta' }),
  board: 'not_checked',
  contactCount: 1,
  strongestStrength: null,
  contacts: [{ id: 'p-3', name: 'Avery Demo', strength: null }],
};
/** A board with none found: no estimate. */
const ECHO: NetworkCompany = {
  company: company({ id: 'n-3', name: 'Echo', atsKind: 'none', atsVerifiedAt: NOW }),
  board: 'not_found',
  contactCount: 1,
  strongestStrength: null,
  contacts: [{ id: 'p-4', name: 'Quinn Mock', strength: null }],
};
const FOXTROT: NetworkCompany = {
  company: company({ id: 'n-4', name: 'Foxtrot', status: 'followed', ...probed, atsRef: 'fox' }),
  board: 'found',
  contactCount: 1,
  strongestStrength: null,
  contacts: [{ id: 'p-5', name: 'Drew Placeholder', strength: null }],
};
const GOLF: NetworkCompany = {
  company: company({ id: 'n-5', name: 'Golf', status: 'denied' }),
  board: 'not_checked',
  contactCount: 1,
  strongestStrength: null,
  contacts: [{ id: 'p-6', name: 'Sam Fixture', strength: null }],
};

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
const figures = (avgCostUsd: number | null) => ({
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
  sources: [],
});
const budget = (spentTodayUsd: number, dailyUsd = 1) => ({
  dailyUsd,
  spentTodayUsd,
  waiting: 0,
  perTaskDailyUsd: 5,
});

function routes(extra: Record<string, unknown> = {}) {
  return mockApi({
    'GET /discovery/network-companies': { items: [CHARLIE, DELTA, ECHO, FOXTROT, GOLF] },
    'GET /companies/suggestions': { items: [ACME, BRAVO], total: 2 },
    'GET /companies': { items: [], total: 0 },
    'GET /discovery/industry-profile': { items: [] },
    'GET /discovery/sources': { items: [], total: 0 },
    // $0.02 a call: a first run of 25 calls is $0.50, and 4 new a day is $0.016 a day.
    'GET /discovery/cost-figures': figures(0.02),
    'GET /discovery/prefilter/recall': RECALL_ON,
    'GET /ai/discovery-budget': budget(0.2),
    ...extra,
  });
}

const list = async () => await screen.findByRole('list', { name: 'Recommended companies' });
const rowOf = (name: string) =>
  within(screen.getByRole('list', { name: 'Recommended companies' })).getByRole('listitem', {
    name,
  });
const box = (name: string) => within(rowOf(name)).getByRole('checkbox', { name: `Select ${name}` });
const bar = () => screen.getByRole('region', { name: 'Selection' });
const rail = () => screen.getByRole('complementary', { name: "Today's discovery budget" });
const posts = (calls: { method: string; path: string }[]) =>
  calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);

async function ready() {
  const l = await list();
  await within(l).findByRole('listitem', { name: 'Acme' });
  // The estimate lines say the figures have been read.
  await within(rowOf('Acme')).findByText(/new a day/);
  await screen.findByText(/Spent today/);
}

describe('#302: selecting companies', () => {
  it('a checkbox on each company that can be followed, and none on a followed or denied one', async () => {
    const user = userEvent.setup();
    routes();
    renderWithProviders(<CompaniesManager />);
    await ready();
    for (const name of ['Acme', 'Bravo', 'Charlie', 'Delta', 'Echo']) {
      expect(box(name)).not.toBeChecked();
    }
    await user.click(screen.getByRole('checkbox', { name: 'Show followed' }));
    await user.click(screen.getByRole('checkbox', { name: 'Show denied' }));
    expect(within(rowOf('Foxtrot')).queryByRole('checkbox', { name: /^Select / })).toBeNull();
    expect(within(rowOf('Golf')).queryByRole('checkbox', { name: /^Select / })).toBeNull();
  });

  it('the selection bar totals the rows checked, and says nothing until one is', async () => {
    const user = userEvent.setup();
    const { calls } = routes();
    renderWithProviders(<CompaniesManager />);
    await ready();
    expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull();
    await user.click(box('Acme'));
    expect(bar()).toHaveTextContent('1 selected');
    expect(bar()).toHaveTextContent('about 4 new a day, est. $0.02 a day; first run 25, $0.50');
    await user.click(box('Bravo'));
    expect(bar()).toHaveTextContent('2 selected');
    // Summed: 8 new a day, 1.6 ranked at $0.02 is $0.032 and shown as $0.03; 50 calls, $1.00.
    expect(bar()).toHaveTextContent('about 8 new a day, est. $0.03 a day; first run 50, $1.00');
    await user.click(box('Acme'));
    expect(bar()).toHaveTextContent('1 selected');
    await user.click(within(bar()).getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull();
    expect(box('Bravo')).not.toBeChecked();
    // Selecting asked for nothing.
    expect(posts(calls)).toEqual([]);
  });

  it('companies with no estimate are counted as selected, and named', async () => {
    const user = userEvent.setup();
    routes();
    renderWithProviders(<CompaniesManager />);
    await ready();
    await user.click(box('Acme'));
    await user.click(box('Delta'));
    await user.click(box('Echo'));
    expect(bar()).toHaveTextContent('3 selected');
    // Only the one with an estimate adds to the figures.
    expect(bar()).toHaveTextContent('about 4 new a day, est. $0.02 a day; first run 25, $0.50');
    const note = within(bar()).getByText('2 without an estimate');
    await user.click(note);
    const names = within(bar()).getByRole('list', { name: 'Selected without an estimate' });
    expect(
      within(names)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Delta', 'Echo']);
  });

  it('with no estimate in the selection it says so, and shows no figures', async () => {
    const user = userEvent.setup();
    routes();
    renderWithProviders(<CompaniesManager />);
    await ready();
    await user.click(box('Delta'));
    expect(bar()).toHaveTextContent('1 selected');
    expect(bar()).toHaveTextContent('1 without an estimate');
    expect(bar()).not.toHaveTextContent('new a day');
  });

  it('a change of filter drops the companies no longer shown from the selection', async () => {
    const user = userEvent.setup();
    routes();
    renderWithProviders(<CompaniesManager />);
    await ready();
    await user.click(box('Acme'));
    await user.click(box('Charlie'));
    expect(bar()).toHaveTextContent('2 selected');
    // Only suggestions: Charlie is hidden, and no longer selected.
    await user.selectOptions(
      within(screen.getByRole('group', { name: 'Filter and sort the companies' })).getByLabelText(
        'Source',
      ),
      'suggested',
    );
    expect(bar()).toHaveTextContent('1 selected');
    expect(box('Acme')).toBeChecked();
  });
});

describe('#302: what a filter hides is no longer selected', () => {
  it('a row hidden by a filter and shown again comes back unchecked', async () => {
    const user = userEvent.setup();
    routes();
    renderWithProviders(<CompaniesManager />);
    await ready();
    await user.click(box('Charlie'));
    const source = within(
      screen.getByRole('group', { name: 'Filter and sort the companies' }),
    ).getByLabelText('Source');
    await user.selectOptions(source, 'suggested');
    expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull();
    await user.selectOptions(source, 'all');
    // Charlie is back on screen, and was not quietly kept selected.
    expect(box('Charlie')).not.toBeChecked();
    expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull();
  });
});

describe("#302: today's budget", () => {
  it('shows what is spent of the budget, and what the selection adds on its first day', async () => {
    const user = userEvent.setup();
    routes();
    renderWithProviders(<CompaniesManager />);
    await ready();
    expect(rail()).toHaveTextContent('Spent today: $0.20 of $1.00');
    expect(within(rail()).getByRole('meter', { name: 'Discovery spend today' })).toHaveAttribute(
      'aria-valuenow',
      '0.2',
    );
    expect(rail()).not.toHaveTextContent('first day');
    await user.click(box('Acme'));
    // 0.20 spent and a first run of $0.50: $0.70 of the $1.00.
    expect(rail()).toHaveTextContent('With the selection’s first run: $0.70 of $1.00');
    await user.click(box('Bravo'));
    expect(rail()).toHaveTextContent('With the selection’s first run: $1.20 of $1.00');
    expect(rail()).toHaveTextContent('over today’s budget');
  });

  it('is left out, and no budget test is made, when the budget could not be read', async () => {
    const user = userEvent.setup();
    routes({ 'GET /ai/discovery-budget': () => ({ status: 500, body: { error: { code: 'x' } } }) });
    renderWithProviders(<CompaniesManager />);
    await within(await list()).findByRole('listitem', { name: 'Acme' });
    await within(rowOf('Acme')).findByText(/new a day/);
    expect(screen.queryByRole('complementary', { name: "Today's discovery budget" })).toBeNull();
    await user.click(box('Acme'));
    expect(bar()).toHaveTextContent('first run 25, $0.50');
  });
});

describe('#302: Follow, and when it asks first', () => {
  it('a selection under every threshold follows at once: a suggestion is accepted, the rest followed', async () => {
    const user = userEvent.setup();
    const { calls } = routes({
      // Two first runs of $0.50 are $1.00 together: not over it, and well within a budget of $5.
      'GET /ai/discovery-budget': budget(0.2, 5),
      'POST /companies/s-1/accept': { ...ACME, status: 'followed' },
      'POST /companies/n-1/follow': { ...CHARLIE.company, status: 'followed' },
    });
    renderWithProviders(<CompaniesManager />);
    await ready();
    await user.click(box('Acme'));
    await user.click(box('Charlie'));
    await user.click(within(bar()).getByRole('button', { name: 'Follow 2 selected' }));
    // In the order of the list: Charlie, who knows two people, then Acme.
    await waitFor(() =>
      expect(posts(calls)).toEqual(['POST /companies/n-1/follow', 'POST /companies/s-1/accept']),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks when the selection’s first run is over $1.00, with the figures, and does nothing on Cancel', async () => {
    const user = userEvent.setup();
    // $0.05 a call: each first run is $1.25.
    const { calls } = routes({
      'GET /discovery/cost-figures': figures(0.05),
      'POST /companies/s-1/accept': { ...ACME, status: 'followed' },
    });
    renderWithProviders(<CompaniesManager />);
    await ready();
    await user.click(box('Acme'));
    await user.click(within(bar()).getByRole('button', { name: 'Follow 1 selected' }));
    const dialog = await screen.findByRole('dialog', { name: 'Follow 1 company?' });
    expect(dialog).toHaveTextContent('first run would cost about $1.25');
    expect(dialog).toHaveTextContent('over $1.00');
    // Itemised: the company and its own figures.
    expect(within(dialog).getByRole('list', { name: 'Companies to follow' })).toHaveTextContent(
      'Acme: first run 25, $1.25; about 4 new a day',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posts(calls)).toEqual([]);
    // Still selected: nothing was decided.
    expect(box('Acme')).toBeChecked();
  });

  it('asks when the selection brings more than 20 new a day, and follows on confirm', async () => {
    const user = userEvent.setup();
    const BIG = company({
      id: 's-9',
      name: 'Bigco',
      status: 'suggested',
      ...probed,
      atsRef: 'bigco',
      boardOpenJobs: 1100,
      boardPrefilterMatches: 20,
    });
    const { calls } = routes({
      'GET /companies/suggestions': { items: [ACME, BIG], total: 2 },
      'POST /companies/s-9/accept': { ...BIG, status: 'followed' },
    });
    renderWithProviders(<CompaniesManager />);
    await ready();
    await user.click(box('Bigco'));
    await user.click(within(bar()).getByRole('button', { name: 'Follow 1 selected' }));
    const dialog = await screen.findByRole('dialog', { name: 'Follow 1 company?' });
    expect(dialog).toHaveTextContent('about 22 new postings a day');
    expect(dialog).toHaveTextContent('more than 20');
    expect(dialog).not.toHaveTextContent('over $1.00');
    await user.click(within(dialog).getByRole('button', { name: 'Follow 1 company' }));
    await waitFor(() => expect(posts(calls)).toEqual(['POST /companies/s-9/accept']));
  });

  it('asks when its first day would take today’s spend over the budget', async () => {
    const user = userEvent.setup();
    routes({ 'GET /ai/discovery-budget': budget(0.6) });
    renderWithProviders(<CompaniesManager />);
    await ready();
    await user.click(box('Acme'));
    await user.click(within(bar()).getByRole('button', { name: 'Follow 1 selected' }));
    const dialog = await screen.findByRole('dialog', { name: 'Follow 1 company?' });
    // 0.60 spent and a first run of $0.50 is $1.10 of the $1.00.
    expect(dialog).toHaveTextContent('$0.60 spent today plus this first run of $0.50');
    expect(dialog).toHaveTextContent('$1.00 budget');
  });

  it('a first day that reaches the budget exactly does not ask', async () => {
    const user = userEvent.setup();
    const { calls } = routes({
      'GET /ai/discovery-budget': budget(0.5),
      'POST /companies/s-1/accept': { ...ACME, status: 'followed' },
    });
    renderWithProviders(<CompaniesManager />);
    await ready();
    await user.click(box('Acme'));
    await user.click(within(bar()).getByRole('button', { name: 'Follow 1 selected' }));
    await waitFor(() => expect(posts(calls)).toEqual(['POST /companies/s-1/accept']));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the Follow button of one row asks too, on that row alone', async () => {
    const user = userEvent.setup();
    const { calls } = routes({
      'GET /discovery/cost-figures': figures(0.05),
      'POST /companies/s-1/accept': { ...ACME, status: 'followed' },
    });
    renderWithProviders(<CompaniesManager />);
    await ready();
    // Bravo is not selected, and Acme's own button is about Acme.
    await user.click(box('Bravo'));
    await user.click(within(rowOf('Acme')).getByRole('button', { name: 'Follow Acme' }));
    const dialog = await screen.findByRole('dialog', { name: 'Follow 1 company?' });
    expect(dialog).toHaveTextContent('Acme');
    expect(dialog).not.toHaveTextContent('Bravo');
    await user.click(within(dialog).getByRole('button', { name: 'Follow 1 company' }));
    await waitFor(() => expect(posts(calls)).toEqual(['POST /companies/s-1/accept']));
  });

  it('a follow that fails part-way carries on, says what happened to each, and keeps the failed ones selected', async () => {
    const user = userEvent.setup();
    routes({
      // $0.01 a call: three first runs are $0.75, under every threshold, so nothing asks first.
      'GET /discovery/cost-figures': figures(0.01),
      'GET /ai/discovery-budget': budget(0.2, 5),
      'POST /companies/s-1/accept': { ...ACME, status: 'followed' },
      'POST /companies/n-1/follow': () => ({
        status: 409,
        body: { error: { code: 'company_denied', message: 'denied' } },
      }),
      'POST /companies/s-2/accept': { ...BRAVO, status: 'followed' },
    });
    renderWithProviders(<CompaniesManager />);
    await ready();
    await user.click(box('Acme'));
    await user.click(box('Charlie'));
    await user.click(box('Bravo'));
    await user.click(within(bar()).getByRole('button', { name: 'Follow 3 selected' }));
    expect(
      await screen.findByText(
        /Followed: Acme, Bravo\. Not followed: Charlie \(That company is denied\. Undo the denial first\.\)/,
      ),
    ).toBeInTheDocument();
    // The one that failed is still selected, the others are no longer.
    await waitFor(() => expect(bar()).toHaveTextContent('1 selected'));
    expect(box('Charlie')).toBeChecked();
  });
});

describe('#302: Deny', () => {
  it('Deny selected acts at once on the selection, a suggestion as a suggestion', async () => {
    const user = userEvent.setup();
    const { calls } = routes({
      'POST /companies/s-1/deny': { ...ACME, status: 'denied' },
      'PATCH /companies/n-2': { ...DELTA.company, status: 'denied' },
    });
    renderWithProviders(<CompaniesManager />);
    await ready();
    await user.click(box('Acme'));
    await user.click(box('Delta'));
    await user.click(within(bar()).getByRole('button', { name: 'Deny 2 selected' }));
    await waitFor(() =>
      expect(posts(calls)).toEqual(['PATCH /companies/n-2', 'POST /companies/s-1/deny']),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('#335: Deny selected, from the bar', () => {
  it('a deny that works leaves nothing selected and says what was denied', async () => {
    const user = userEvent.setup();
    routes({
      'PATCH /companies/n-1': { ...CHARLIE.company, status: 'denied' },
      'POST /companies/s-1/deny': { ...ACME, status: 'denied' },
    });
    renderWithProviders(<CompaniesManager />);
    await ready();
    await user.click(box('Charlie'));
    await user.click(box('Acme'));
    await user.click(within(bar()).getByRole('button', { name: 'Deny 2 selected' }));
    expect(await screen.findByText('Charlie, Acme')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull());
  });

  it('one that fails part-way carries on, names each row, and keeps the failed one selected', async () => {
    const user = userEvent.setup();
    const { calls } = routes({
      'PATCH /companies/n-1': { ...CHARLIE.company, status: 'denied' },
      'PATCH /companies/n-2': () => ({
        status: 409,
        body: { error: { code: 'duplicate', message: 'a company with that name exists' } },
      }),
      'POST /companies/s-1/deny': { ...ACME, status: 'denied' },
    });
    renderWithProviders(<CompaniesManager />);
    await ready();
    await user.click(box('Charlie'));
    await user.click(box('Delta'));
    await user.click(box('Acme'));
    await user.click(within(bar()).getByRole('button', { name: 'Deny 3 selected' }));
    expect(
      await screen.findByText(/Denied: Charlie, Acme\. Not denied: Delta \(/),
    ).toBeInTheDocument();
    // The one that failed is still selected, the others are no longer; all three were tried.
    await waitFor(() => expect(bar()).toHaveTextContent('1 selected'));
    expect(box('Delta')).toBeChecked();
    expect(posts(calls)).toEqual([
      'PATCH /companies/n-1',
      'PATCH /companies/n-2',
      'POST /companies/s-1/deny',
    ]);
  });

  it('a network failure reads as one, not as the browser’s "Failed to fetch" (qa on #332)', async () => {
    const user = userEvent.setup();
    routes({
      'POST /companies/s-1/accept': () => {
        throw new TypeError('Failed to fetch');
      },
      'GET /ai/discovery-budget': budget(0.2, 5),
    });
    renderWithProviders(<CompaniesManager />);
    await ready();
    await user.click(box('Acme'));
    await user.click(within(bar()).getByRole('button', { name: 'Follow 1 selected' }));
    expect(
      await screen.findByText(
        /Not followed: Acme \(Could not reach Opportun\. Check your connection and try again\.\)/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Failed to fetch/)).toBeNull();
    // Still selected, to try again.
    expect(box('Acme')).toBeChecked();
  });
});

describe('#302: the keyboard', () => {
  const cursorName = () =>
    screen
      .getAllByRole('listitem')
      .find((li) => li.getAttribute('aria-current') === 'true')
      ?.querySelector('[data-company-name]')?.textContent;

  it('j and k move the cursor through the rows, and Space checks the row it is on', async () => {
    const user = userEvent.setup();
    routes();
    renderWithProviders(<CompaniesManager />);
    await ready();
    expect(cursorName()).toBeUndefined();
    // Most people you know first: Charlie (2), then Delta and Echo (1 each), then the suggestions.
    await user.keyboard('j');
    expect(cursorName()).toBe('Charlie');
    await user.keyboard('j');
    expect(cursorName()).toBe('Delta');
    await user.keyboard('k');
    expect(cursorName()).toBe('Charlie');
    await user.keyboard('k');
    expect(cursorName()).toBe('Charlie');
    await user.keyboard(' ');
    expect(box('Charlie')).toBeChecked();
    await user.keyboard(' ');
    expect(box('Charlie')).not.toBeChecked();
  });

  it('f follows the cursor row, with the confirm when it applies; x denies it at once', async () => {
    const user = userEvent.setup();
    const { calls } = routes({
      'GET /discovery/cost-figures': figures(0.05),
      'POST /companies/n-1/follow': { ...CHARLIE.company, status: 'followed' },
      'PATCH /companies/n-2': { ...DELTA.company, status: 'denied' },
    });
    renderWithProviders(<CompaniesManager />);
    await ready();
    await user.keyboard('j'); // Charlie, with a first run of $1.25
    await user.keyboard('f');
    const dialog = await screen.findByRole('dialog', { name: 'Follow 1 company?' });
    expect(dialog).toHaveTextContent('Charlie');
    expect(posts(calls)).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Follow 1 company' }));
    await waitFor(() => expect(posts(calls)).toEqual(['POST /companies/n-1/follow']));
    await user.keyboard('j'); // Delta (Charlie is gone once followed), no estimate
    await user.keyboard('x');
    await waitFor(() => expect(posts(calls).at(-1)).toBe('PATCH /companies/n-2'));
  });

  it('f, x and Space do nothing on a row that is followed or denied', async () => {
    const user = userEvent.setup();
    const { calls } = routes();
    renderWithProviders(<CompaniesManager />);
    await ready();
    await user.click(screen.getByRole('checkbox', { name: 'Show followed' }));
    await within(await list()).findByRole('listitem', { name: 'Foxtrot' });
    // Move to Foxtrot, a followed company in the list.
    for (let i = 0; i < 6 && cursorName() !== 'Foxtrot'; i++) await user.keyboard('j');
    expect(cursorName()).toBe('Foxtrot');
    await user.keyboard('fx ');
    expect(posts(calls)).toEqual([]);
    expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape clears the selection', async () => {
    const user = userEvent.setup();
    routes();
    renderWithProviders(<CompaniesManager />);
    await ready();
    await user.click(box('Acme'));
    expect(bar()).toHaveTextContent('1 selected');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull();
  });

  it('does nothing while focus is in a field or a select: an f typed into the industry select follows nothing', async () => {
    const user = userEvent.setup();
    const { calls } = routes({
      'POST /companies/n-1/follow': { ...CHARLIE.company, status: 'followed' },
    });
    renderWithProviders(<CompaniesManager />);
    await ready();
    await user.keyboard('j'); // the cursor is on Charlie
    const industry = within(
      screen.getByRole('group', { name: 'Filter and sort the companies' }),
    ).getByLabelText('Industry');
    industry.focus();
    await user.keyboard('fxjk ');
    expect(posts(calls)).toEqual([]);
    expect(cursorName()).toBe('Charlie');
    expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull();
  });

  it('does nothing while a dialog is open', async () => {
    const user = userEvent.setup();
    const { calls } = routes({ 'GET /discovery/cost-figures': figures(0.05) });
    renderWithProviders(<CompaniesManager />);
    await ready();
    await user.click(box('Acme'));
    await user.click(within(bar()).getByRole('button', { name: 'Follow 1 selected' }));
    await screen.findByRole('dialog', { name: 'Follow 1 company?' });
    await user.keyboard('fx j');
    expect(posts(calls)).toEqual([]);
  });

  it('selecting, moving and the keys make no request', async () => {
    const user = userEvent.setup();
    const { calls } = routes();
    renderWithProviders(<CompaniesManager />);
    await ready();
    const before = calls.length;
    await user.keyboard('jj ');
    await user.click(box('Acme'));
    await user.keyboard('{Escape}');
    expect(calls).toHaveLength(before);
  });
});

describe('#302: Undo denying has its own name in the list', () => {
  it('the list says where it is, and the Denied companies section keeps its own', async () => {
    const user = userEvent.setup();
    routes({
      'GET /companies': (call: { search: string }) =>
        new URLSearchParams(call.search).get('status') === 'denied'
          ? { items: [GOLF.company], total: 1 }
          : { items: [], total: 0 },
    });
    renderWithProviders(<CompaniesManager />);
    await ready();
    await user.click(screen.getByRole('checkbox', { name: 'Show denied' }));
    await within(rowOf('Golf')).findByRole('button', {
      name: 'Undo denying Golf in Recommended companies',
    });
    // One button of each name: none is a second "Undo denying Golf".
    expect(screen.getAllByRole('button', { name: 'Undo denying Golf' })).toHaveLength(1);
    expect(
      screen.getAllByRole('button', { name: 'Undo denying Golf in Recommended companies' }),
    ).toHaveLength(1);
  });
});
