import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import type { PromptVersion } from './api';
import { ProposedRefinement } from './ProposedRefinement';

const NOW = Date.now();
const ACTIVE: PromptVersion = {
  id: 'seed-1',
  taskKey: 'comms.classify',
  name: 'default',
  body: 'Classify the message.\nReturn JSON.',
  version: 1,
  parentId: null,
  isActive: true,
  isSystem: true,
  proposed: false,
  proposalSummary: null,
  createdAt: NOW - 1000,
};
const PROPOSAL: PromptVersion = {
  ...ACTIVE,
  id: 'p-2',
  body: 'Classify the message.\nAgency blasts are broadcast_spam.\nReturn JSON.',
  version: 2,
  parentId: 'seed-1',
  isActive: false,
  isSystem: false,
  proposed: true,
  proposalSummary: 'Agency blasts now count as spam.',
  createdAt: NOW,
};

describe('ProposedRefinement', () => {
  it('shows the diff and summary, and Accept calls the accept endpoint', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /ai/prompts': { items: [PROPOSAL, ACTIVE] },
      'POST /ai/prompts/p-2/accept-proposal': { ...PROPOSAL, isActive: true, proposed: false },
    });
    renderWithProviders(<ProposedRefinement />);
    expect(await screen.findByText('Proposed refinement')).toBeInTheDocument();
    expect(screen.getByText('Agency blasts now count as spam.')).toBeInTheDocument();
    expect(screen.getByRole('insertion')).toHaveTextContent('Agency blasts are broadcast_spam.');
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
        '/ai/prompts/p-2/accept-proposal',
      ]),
    );
  });

  it('Discard calls the discard endpoint', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /ai/prompts': { items: [PROPOSAL, ACTIVE] },
      'POST /ai/prompts/p-2/discard-proposal': () => ({ status: 204 }),
    });
    renderWithProviders(<ProposedRefinement />);
    await user.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
        '/ai/prompts/p-2/discard-proposal',
      ]),
    );
  });

  it('renders nothing without a pending proposal', async () => {
    const { calls } = mockApi({ 'GET /ai/prompts': { items: [ACTIVE] } });
    const { container } = renderWithProviders(<ProposedRefinement />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(container).not.toHaveTextContent('Proposed refinement');
  });
});
