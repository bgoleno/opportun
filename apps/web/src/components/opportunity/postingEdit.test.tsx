// Editing the posting fields (Task 7, FR-O1): the description and the posting link are editable
// after creation, which is what closes the hole that left imported opportunities blank forever.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { OpportunityView } from '@/lib/opportunities';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { DetailsPanel } from './DetailsPanel';

const NOW = Date.now();

const OPP = {
  id: 'opp-1',
  userId: 'u1',
  companyId: 'c1',
  companyName: 'Sentinel Edge',
  title: 'Product Manager, SIEM',
  stage: 'in_process',
  sourceKind: 'import',
  priority: 2,
  descriptionMd: 'the description I already had',
  postingUrl: null,
  location: null,
  remote: null,
  compNote: null,
  createdAt: NOW,
  updatedAt: NOW,
} as unknown as OpportunityView;

function setup() {
  return mockApi({
    'GET /opportunities/opp-1/attachments': { items: [], total: 0 },
    'PATCH /opportunities/opp-1': (c: ApiCall) => ({ ...OPP, ...(c.body as object) }),
  });
}

const patches = (api: { calls: ApiCall[] }) => api.calls.filter((c) => c.method === 'PATCH');

describe('posting fields', () => {
  it('edits the description and saves it through PATCH', async () => {
    const api = setup();
    renderWithProviders(<DetailsPanel opp={OPP} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Edit description' }));
    const field = screen.getByLabelText('Description');
    await userEvent.clear(field);
    await userEvent.type(field, 'Own the SIEM roadmap.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patches(api)).toHaveLength(1));
    expect(patches(api)[0]!.body).toEqual({ descriptionMd: 'Own the SIEM roadmap.' });
  });

  it('edits the posting link and rejects a value that is not a link', async () => {
    const api = setup();
    renderWithProviders(<DetailsPanel opp={OPP} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Edit link' }));
    const field = screen.getByLabelText('Posting link');
    await userEvent.type(field, 'not a link');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Enter an http or https link')).toBeInTheDocument();
    expect(patches(api)).toHaveLength(0);

    await userEvent.clear(field);
    await userEvent.type(field, 'https://job-boards.greenhouse.io/sentineledge/jobs/7663059003');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patches(api)).toHaveLength(1));
    expect(patches(api)[0]!.body).toEqual({
      postingUrl: 'https://job-boards.greenhouse.io/sentineledge/jobs/7663059003',
    });
  });

  it('cancels an edit without sending anything', async () => {
    const api = setup();
    renderWithProviders(<DetailsPanel opp={OPP} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Edit description' }));
    await userEvent.type(screen.getByLabelText('Description'), ' and more');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(patches(api)).toHaveLength(0);
    expect(screen.getByText('the description I already had')).toBeInTheDocument();
  });

  it('clears the posting link when the field is emptied', async () => {
    const api = setup();
    renderWithProviders(
      <DetailsPanel
        opp={{ ...OPP, postingUrl: 'https://example.com/jobs/1' } as OpportunityView}
      />,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Edit link' }));
    await userEvent.clear(screen.getByLabelText('Posting link'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patches(api)).toHaveLength(1));
    expect(patches(api)[0]!.body).toEqual({ postingUrl: null });
  });
});
