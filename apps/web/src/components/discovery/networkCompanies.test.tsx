// The "In your network" section of the Companies tab (https://github.com/bgoleno/opportun/issues/216):
// mockup A's row with its badge, follow and board states, the names only behind the "You know N
// people" disclosure, Follow as accept does, Deny, and denied companies only with "Show denied".
// All names and companies are made up.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { CompaniesManager } from './CompaniesManager';
import type { CompanyView, NetworkCompany } from './companiesApi';
import { closeSplit, knowLine } from './NetworkCompanyRow';

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
  company: company({ id: 'n-2', name: 'Northwind Traders', atsKind: 'none', atsVerifiedAt: NOW }),
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

function network(call: ApiCall) {
  const showDenied = new URLSearchParams(call.search).get('showDenied') === 'true';
  return {
    items: showDenied ? [CONTOSO, INITECH, NORTHWIND, TAILSPIN] : [CONTOSO, NORTHWIND, TAILSPIN],
  };
}

function routes(extra: Record<string, unknown> = {}) {
  return mockApi({
    'GET /discovery/network-companies': network,
    'GET /companies/suggestions': { items: [], total: 0 },
    'GET /companies': { items: [], total: 0 },
    'GET /discovery/sources': { items: [], total: 0 },
    ...extra,
  });
}

const networkList = async () =>
  await screen.findByRole('list', { name: 'Companies in your network' });

describe('#216: the companies in your network', () => {
  it('each row: the badge, the follow state and the board state, found, not found or not checked', async () => {
    routes();
    renderWithProviders(<CompaniesManager />);
    const list = await networkList();
    const contoso = await within(list).findByRole('listitem', { name: 'Contoso' });
    expect(within(contoso).getByText('In your network')).toBeInTheDocument();
    expect(within(contoso).getByText('Following')).toBeInTheDocument();
    expect(contoso).toHaveTextContent('Lever: contoso');
    expect(within(contoso).queryByRole('button', { name: 'Follow Contoso' })).toBeNull();

    const northwind = within(list).getByRole('listitem', { name: 'Northwind Traders' });
    expect(within(northwind).getByText('In your network')).toBeInTheDocument();
    expect(northwind).toHaveTextContent('No board found');
    expect(within(northwind).queryByText('Following')).toBeNull();

    const tailspin = within(list).getByRole('listitem', { name: 'Tailspin Toys' });
    expect(tailspin).toHaveTextContent('Not checked yet');
  });

  it('names show only behind the "You know N people" disclosure', async () => {
    const user = userEvent.setup();
    routes();
    renderWithProviders(<CompaniesManager />);
    const contoso = await within(await networkList()).findByRole('listitem', { name: 'Contoso' });
    const details = contoso.querySelector('details');
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    const summary = details!.querySelector('summary')!;
    expect(summary).toHaveTextContent('You know 3 people here (1 close, 2 others)');
    // Every name is inside the closed disclosure, none in the summary or elsewhere in the row.
    for (const name of ['Riley Sample', 'Morgan Example', 'Casey Placeholder']) {
      expect(summary).not.toHaveTextContent(name);
      expect(within(details!).getByText(name, { exact: false })).toBeInTheDocument();
    }
    const outside = [...contoso.children].filter((el) => el !== details);
    expect(outside.map((el) => el.textContent).join(' ')).not.toMatch(/Riley|Morgan|Casey/);

    await user.click(summary);
    expect(details!.open).toBe(true);
    expect(
      within(details!).getByRole('list', { name: 'People you know at Contoso' }),
    ).toHaveTextContent('Riley Sample · Close');
  });

  it('Follow calls the follow endpoint, not accept', async () => {
    const user = userEvent.setup();
    const { calls } = routes({
      'POST /companies/n-2/follow': { ...NORTHWIND.company, status: 'followed' },
    });
    renderWithProviders(<CompaniesManager />);
    const row = await within(await networkList()).findByRole('listitem', {
      name: 'Northwind Traders',
    });
    await user.click(within(row).getByRole('button', { name: 'Follow Northwind Traders' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`)).toEqual([
        'POST /companies/n-2/follow',
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
    const row = await within(await networkList()).findByRole('listitem', {
      name: 'Northwind Traders',
    });
    await user.click(within(row).getByRole('button', { name: 'Follow Northwind Traders' }));
    expect(
      await screen.findByText('That company is denied. Undo the denial first.'),
    ).toBeInTheDocument();
  });

  it('Deny sets the status to denied', async () => {
    const user = userEvent.setup();
    const { calls } = routes({
      'PATCH /companies/n-3': { ...TAILSPIN.company, status: 'denied' },
    });
    renderWithProviders(<CompaniesManager />);
    const row = await within(await networkList()).findByRole('listitem', { name: 'Tailspin Toys' });
    await user.click(within(row).getByRole('button', { name: 'Deny Tailspin Toys' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.path).toBe('/companies/n-3');
    expect(patch?.body).toEqual({ status: 'denied' });
  });

  it('a denied company is hidden unless "Show denied" is chosen, then it can be undone', async () => {
    const user = userEvent.setup();
    const { calls } = routes({ 'PATCH /companies/n-4': { ...INITECH.company, status: 'none' } });
    renderWithProviders(<CompaniesManager />);
    const list = await networkList();
    await within(list).findByRole('listitem', { name: 'Contoso' });
    expect(within(list).queryByRole('listitem', { name: 'Initech' })).toBeNull();
    expect(
      calls.filter((c) => c.path === '/discovery/network-companies').map((c) => c.search),
    ).toEqual(['']);

    await user.click(screen.getByRole('checkbox', { name: 'Show denied' }));
    const initech = await within(list).findByRole('listitem', { name: 'Initech' });
    expect(within(initech).getByText('Denied')).toBeInTheDocument();
    expect(within(initech).queryByRole('button', { name: 'Follow Initech' })).toBeNull();
    expect(calls.some((c) => c.search === '?showDenied=true')).toBe(true);

    await user.click(within(initech).getByRole('button', { name: 'Undo denying Initech' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'none' }),
    );
  });

  it('renders a hostile company or contact name inert, as text', async () => {
    const HOSTILE = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
    routes({
      'GET /discovery/network-companies': {
        items: [
          {
            ...TAILSPIN,
            company: { ...TAILSPIN.company, name: `Evil <b>Corp</b>` },
            contacts: [{ id: 'p-x', name: HOSTILE, strength: 3 }],
          },
        ],
      },
    });
    renderWithProviders(<CompaniesManager />);
    const list = await networkList();
    const row = await within(list).findByRole('listitem', { name: 'Evil <b>Corp</b>' });
    expect(row.querySelector('script, img, b')).toBeNull();
    expect(row).toHaveTextContent(HOSTILE);
    expect((window as unknown as { __pwned?: unknown }).__pwned).toBeUndefined();
  });

  it('says so when there are none', async () => {
    routes({ 'GET /discovery/network-companies': { items: [] } });
    renderWithProviders(<CompaniesManager />);
    expect(
      await screen.findByText(
        "None yet. Add your contacts' current companies under Network to see them here.",
      ),
    ).toBeInTheDocument();
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
