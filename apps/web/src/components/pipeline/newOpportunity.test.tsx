import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { NewOpportunityDialog } from './NewOpportunityDialog';

describe('NewOpportunityDialog', () => {
  it('creates a manual opportunity, and offers Create anyway on a duplicate', async () => {
    const api = mockApi({
      'POST /opportunities': (call: ApiCall) =>
        call.search.includes('force=true')
          ? { status: 201, body: { id: 'new-1', title: 'Staff PM', companyName: 'Acme' } }
          : { status: 409, body: { error: { code: 'duplicate', existingId: 'opp-9' } } },
    });
    const user = userEvent.setup();
    renderWithProviders(<NewOpportunityDialog open onOpenChange={() => undefined} />);

    const dialog = await screen.findByRole('dialog', { name: 'New opportunity' });
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText('Enter the company')).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);

    await user.type(within(dialog).getByLabelText('Company'), 'Acme');
    await user.type(within(dialog).getByLabelText('Title'), 'Staff PM');
    await user.type(within(dialog).getByLabelText('Posting URL'), 'javascript:alert(1)');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText('Enter an http or https URL')).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('Posting URL'));
    await user.type(within(dialog).getByLabelText('Posting URL'), 'https://acme.example/jobs/1');
    await user.type(within(dialog).getByLabelText('Location'), 'Remote');
    await user.type(within(dialog).getByLabelText('Description'), 'Platform team');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));

    const existing = await within(dialog).findByRole('link', {
      name: 'View the existing opportunity',
    });
    expect(existing).toHaveAttribute('href', '/opportunities/opp-9');
    expect(api.calls[0]).toMatchObject({
      method: 'POST',
      path: '/opportunities',
      search: '',
      body: {
        companyName: 'Acme',
        title: 'Staff PM',
        postingUrl: 'https://acme.example/jobs/1',
        location: 'Remote',
        descriptionMd: 'Platform team',
        sourceKind: 'manual',
      },
    });

    await user.click(within(dialog).getByRole('button', { name: 'Create anyway' }));
    await waitFor(() => expect(api.calls).toHaveLength(2));
    expect(api.calls[1]).toMatchObject({ search: '?force=true', body: api.calls[0]?.body });
  });
});
