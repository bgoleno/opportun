import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { OpportunityView } from '@/lib/opportunities';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { PossibleDuplicateBanner } from './PossibleDuplicateBanner';

const NOW = Date.now();

const OPP = {
  id: 'opp-1',
  userId: 'u1',
  companyId: 'c1',
  companyName: 'Acme',
  title: 'Staff PM',
  stage: 'applied',
  sourceKind: 'manual',
  priority: 2,
  possibleDuplicates: ['opp-2'],
  createdAt: NOW,
  updatedAt: NOW,
} as OpportunityView;

const OTHER = {
  id: 'opp-2',
  userId: 'u1',
  companyId: 'c1',
  companyName: 'Acme',
  title: 'Staff PM (dup)',
  stage: 'discovered',
  sourceKind: 'manual',
  priority: 2,
  possibleDuplicates: ['opp-1'],
  createdAt: NOW,
  updatedAt: NOW,
} as OpportunityView;

function setup(opp: OpportunityView = OPP, extra: Record<string, unknown> = {}) {
  const api = mockApi({ 'GET /opportunities/opp-2': OTHER, ...extra });
  const user = userEvent.setup();
  const rendered = renderWithProviders(<PossibleDuplicateBanner opp={opp} />);
  return { ...rendered, api, user };
}

describe('PossibleDuplicateBanner', () => {
  it('renders nothing when nothing is flagged', () => {
    setup({ ...OPP, possibleDuplicates: [] });
    expect(screen.queryByText(/possible duplicate/i)).not.toBeInTheDocument();
  });

  it('names the flagged opportunity and links to it', async () => {
    setup();
    const link = await screen.findByRole('link', { name: /Staff PM \(dup\)/ });
    expect(link).toHaveAttribute('href', '/opportunities/opp-2');
  });

  it('merges this opportunity away after a confirm step, then goes to the kept one', async () => {
    const { api, user, router } = setup(OPP, {
      'POST /opportunities/opp-2/merge': OTHER,
    });
    await screen.findByRole('link', { name: /Staff PM \(dup\)/ });
    await user.click(screen.getByRole('button', { name: 'Merge' }));
    // Confirm step: a second, more committal button appears.
    await user.click(screen.getByRole('button', { name: 'Merge this opportunity in' }));
    await waitFor(() =>
      expect(
        api.calls.some((c) => c.method === 'POST' && c.path === '/opportunities/opp-2/merge'),
      ).toBe(true),
    );
    const call = api.calls.find(
      (c: ApiCall) => c.method === 'POST' && c.path === '/opportunities/opp-2/merge',
    );
    expect(call?.body).toEqual({ otherId: 'opp-1' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/opportunities/opp-2'));
  });

  it('dismisses as not a duplicate, which is a persisted call, not just local state', async () => {
    const { api, user } = setup(OPP, {
      'POST /opportunities/opp-1/dismiss-duplicate': { ...OPP, possibleDuplicates: [] },
    });
    await screen.findByRole('link', { name: /Staff PM \(dup\)/ });
    await user.click(screen.getByRole('button', { name: 'Not a duplicate' }));
    await waitFor(() =>
      expect(
        api.calls.some(
          (c) => c.method === 'POST' && c.path === '/opportunities/opp-1/dismiss-duplicate',
        ),
      ).toBe(true),
    );
    const call = api.calls.find(
      (c: ApiCall) => c.path === '/opportunities/opp-1/dismiss-duplicate',
    );
    expect(call?.body).toEqual({ otherId: 'opp-2' });
  });
});
