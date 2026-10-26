import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { ReferralsTab } from './ReferralsTab';

const candidate = (over: Record<string, unknown>) => ({
  linkedinUrl: null,
  relation: 'current',
  currentCompanyName: 'Initech',
  title: null,
  strength: null,
  rank: null,
  rationale: null,
  ...over,
});

const CANDIDATES = {
  items: [
    candidate({
      contactId: 'c-sam',
      name: 'Sam Lee',
      relation: 'former',
      currentCompanyName: 'Hooli',
      title: 'Engineering Manager',
      rank: 1,
      rationale: 'Managed the Initech platform team for four years.',
    }),
    candidate({
      contactId: 'c-jane',
      name: 'Jane Doe',
      title: 'Director, Platform Engineering',
      strength: 2,
      rank: 2,
      rationale: 'Directs platform engineering there now.',
    }),
    candidate({ contactId: 'c-lee', name: 'Lee Park', strength: 3 }),
  ],
  total: 3,
  ranked: true,
  aiUnavailable: null,
};

const janeAsk = {
  activityId: 'act-jane',
  contactId: 'c-jane',
  name: 'Jane Doe',
  status: 'asked',
  note: null,
  occurredAt: Date.UTC(2026, 9, 10),
};

describe('ReferralsTab', () => {
  it('renders ranked candidates, asks for a referral, and updates a status chip', async () => {
    const asks: Record<string, unknown>[] = [{ ...janeAsk }];
    const { calls } = mockApi({
      'GET /opportunities/opp-1/referral-candidates': CANDIDATES,
      'GET /opportunities/opp-1/referrals': () => ({ items: asks, total: asks.length }),
      'POST /opportunities/opp-1/referrals': (call: ApiCall) => {
        const { contactId } = call.body as { contactId: string };
        asks.unshift({ ...janeAsk, activityId: 'act-sam', contactId, name: 'Sam Lee' });
        return { status: 201, body: { id: 'act-sam', kind: 'referral' } };
      },
      'PATCH /activities/act-jane': (call: ApiCall) => {
        const status = (call.body as { referralStatus: string }).referralStatus;
        asks.splice(
          asks.findIndex((a) => a.activityId === 'act-jane'),
          1,
          { ...janeAsk, status },
        );
        return { id: 'act-jane', kind: 'referral', bodyMd: `Status: ${status}` };
      },
    });
    renderWithProviders(<ReferralsTab opportunityId="opp-1" companyName="Initech" />);
    const user = userEvent.setup();

    // Ranked candidates come first, each with its rank and rationale.
    const list = await screen.findByRole('list', { name: 'Referral candidates' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => within(r).getByRole('heading').textContent)).toEqual([
      'Sam Lee',
      'Jane Doe',
      'Lee Park',
    ]);
    expect(within(rows[0]!).getByText('#1')).toBeInTheDocument();
    expect(
      within(rows[0]!).getByText('Managed the Initech platform team for four years.'),
    ).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/Former, Engineering Manager/)).toBeInTheDocument();
    expect(within(rows[2]!).queryByText(/^#/)).toBeNull();
    // Jane was already asked: her row shows the status, not another Ask.
    expect(within(rows[1]!).queryByRole('button', { name: /Ask/ })).toBeNull();
    expect(within(rows[1]!).getByText('Asked')).toBeInTheDocument();

    // Ask posts the referral for that contact.
    await user.click(within(rows[0]!).getByRole('button', { name: 'Ask Sam Lee for a referral' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ contactId: 'c-sam' }),
    );
    const asksList = await screen.findByRole('list', { name: 'Referral asks' });
    expect(await within(asksList).findByText('Sam Lee')).toBeInTheDocument();

    // The status chips PATCH the activity; the chosen chip is pressed.
    const group = within(asksList).getByRole('group', { name: 'Status for Jane Doe' });
    expect(within(group).getByRole('button', { name: 'Asked' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(within(group).getByRole('button', { name: 'Agreed' }));
    await waitFor(() =>
      expect(within(group).getByRole('button', { name: 'Agreed' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch).toMatchObject({
      path: '/activities/act-jane',
      body: { referralStatus: 'agreed' },
    });
    expect(within(group).getByRole('button', { name: 'Asked' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('shows the unranked set with a note when AI is unavailable, and an empty state', async () => {
    mockApi({
      'GET /opportunities/opp-1/referral-candidates': {
        ...CANDIDATES,
        items: CANDIDATES.items.map((c) => ({ ...c, rank: null, rationale: null })),
        ranked: false,
        aiUnavailable: 'no_key',
      },
      'GET /opportunities/opp-1/referrals': { items: [], total: 0 },
    });
    renderWithProviders(<ReferralsTab opportunityId="opp-1" companyName="Initech" />);
    expect(await screen.findByText(/not ranked by AI/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Ask / })).toHaveLength(3);
  });

  it('points to contacts and the LinkedIn import when nobody is at the company', async () => {
    mockApi({
      'GET /opportunities/opp-1/referral-candidates': {
        items: [],
        total: 0,
        ranked: false,
        aiUnavailable: null,
      },
      'GET /opportunities/opp-1/referrals': { items: [], total: 0 },
    });
    renderWithProviders(<ReferralsTab opportunityId="opp-1" companyName="Initech" />);
    expect(await screen.findByText(/No contacts at Initech yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'import your LinkedIn export' })).toHaveAttribute(
      'href',
      '/settings/data',
    );
  });
});
