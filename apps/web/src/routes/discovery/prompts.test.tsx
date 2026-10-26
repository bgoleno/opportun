import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PromptVersion } from '@/components/ai/api';
import { DiscoveryPrompts } from '@/components/discovery/DiscoveryPrompts';
import type { RoleTargetDiscoveryPrompt } from '@/components/discovery/api';
import { mockApi, renderWithProviders } from '@/test/render';

const NOW = Date.now();
const SEED: PromptVersion = {
  id: 'seed-1',
  taskKey: 'discovery.rank',
  name: 'default',
  body: 'Rank {{posting_untrusted}} for {{role_target}}.\nReturn JSON.',
  version: 1,
  parentId: null,
  isActive: true,
  isSystem: true,
  proposed: false,
  proposalSummary: null,
  createdAt: NOW - 3000,
};
const OTHER: PromptVersion = {
  ...SEED,
  id: 'v-2',
  body: 'Rank {{posting_untrusted}} for {{role_target}}.\nPrefer platform roles.\nReturn JSON.',
  version: 2,
  parentId: 'seed-1',
  isActive: false,
  isSystem: false,
  createdAt: NOW - 2000,
};
const PROPOSAL: PromptVersion = {
  ...SEED,
  id: 'p-3',
  body: 'Rank {{posting_untrusted}} for {{role_target}}.\nSkip agencies.\nReturn JSON.',
  version: 3,
  parentId: 'seed-1',
  isActive: false,
  isSystem: false,
  proposed: true,
  proposalSummary: 'You dismissed agency postings five times.',
  createdAt: NOW - 1000,
};

const ROLE_TARGETS = {
  items: [
    { id: 'rt-1', name: 'Staff platform' },
    { id: 'rt-2', name: 'EM' },
  ],
  total: 2,
};

function view(over: Partial<RoleTargetDiscoveryPrompt> = {}): RoleTargetDiscoveryPrompt {
  return { roleTargetId: 'rt-1', prompt: SEED, linked: false, proposal: null, ...over };
}

function routes(extra: Record<string, unknown> = {}) {
  return {
    'GET /role-targets': ROLE_TARGETS,
    'GET /ai/prompts': { items: [PROPOSAL, OTHER, SEED] },
    'GET /role-targets/rt-1/discovery-prompt': view(),
    ...extra,
  };
}

describe('DiscoveryPrompts', () => {
  it('editing creates a version scoped to the role target (not a global prompt)', async () => {
    const user = userEvent.setup();
    const created: PromptVersion = { ...OTHER, id: 'v-4', version: 4, body: 'x' };
    const { calls } = mockApi(
      routes({
        'POST /role-targets/rt-1/discovery-prompt': () => ({
          status: 201,
          body: view({ prompt: created, linked: true }),
        }),
      }),
    );
    renderWithProviders(<DiscoveryPrompts roleTargetId="rt-1" onRoleTargetChange={vi.fn()} />);
    const editor = await screen.findByLabelText('Prompt text');
    expect(editor).toHaveValue(SEED.body);
    await user.clear(editor);
    await user.click(editor);
    await user.paste('Rank {{posting_untrusted}} for {{role_target}}.\nNo agencies.');
    await user.click(screen.getByRole('button', { name: 'Save as new version' }));
    await waitFor(() => {
      const posts = calls.filter((c) => c.method === 'POST');
      expect(posts).toHaveLength(1);
      expect(posts[0]?.path).toBe('/role-targets/rt-1/discovery-prompt');
      expect(posts[0]?.body).toEqual({
        body: 'Rank {{posting_untrusted}} for {{role_target}}.\nNo agencies.',
      });
    });
    expect(calls.some((c) => c.method === 'POST' && c.path === '/ai/prompts')).toBe(false);
  });

  it('warns when a draft drops a placeholder', async () => {
    const user = userEvent.setup();
    mockApi(routes());
    renderWithProviders(<DiscoveryPrompts roleTargetId="rt-1" onRoleTargetChange={vi.fn()} />);
    const editor = await screen.findByLabelText('Prompt text');
    await user.clear(editor);
    await user.type(editor, 'Just rank it.');
    expect(screen.getByText(/This draft no longer uses/)).toHaveTextContent(
      '{{posting_untrusted}}',
    );
  });

  it('activate links the version to the role target; reset unlinks it', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi(
      routes({
        'GET /role-targets/rt-1/discovery-prompt': view({ prompt: OTHER, linked: true }),
        'PUT /role-targets/rt-1/discovery-prompt': (call: { body: unknown }) =>
          view({
            prompt: (call.body as { promptId: string | null }).promptId === null ? SEED : OTHER,
            linked: (call.body as { promptId: string | null }).promptId !== null,
          }),
      }),
    );
    renderWithProviders(<DiscoveryPrompts roleTargetId="rt-1" onRoleTargetChange={vi.fn()} />);
    const versions = await screen.findByRole('table', { name: 'Discovery prompt versions' });
    // The version in use is marked; proposals are not offered for activation here.
    expect(within(versions).getByText('In use')).toBeInTheDocument();
    expect(within(versions).queryByText('v3')).toBeNull();
    await user.click(within(versions).getByRole('button', { name: 'Use v1 for this role target' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
        { promptId: 'seed-1' },
      ]),
    );
    expect(calls.some((c) => c.path.endsWith('/activate'))).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Reset to default' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
        { promptId: 'seed-1' },
        { promptId: null },
      ]),
    );
  });

  it('shows the role target proposal with a diff; Accept and Discard call their endpoints', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi(
      routes({
        'GET /role-targets/rt-1/discovery-prompt': view({ proposal: PROPOSAL }),
        'POST /ai/prompts/p-3/accept-proposal': { ...PROPOSAL, proposed: false },
        'POST /ai/prompts/p-3/discard-proposal': () => ({ status: 204 }),
      }),
    );
    renderWithProviders(<DiscoveryPrompts roleTargetId="rt-1" onRoleTargetChange={vi.fn()} />);
    const card = (await screen.findByText('Proposed refinement')).closest('[data-slot="card"]');
    expect(card).not.toBeNull();
    const scope = within(card as HTMLElement);
    expect(scope.getByText('You dismissed agency postings five times.')).toBeInTheDocument();
    expect(scope.getByRole('insertion')).toHaveTextContent('Skip agencies.');
    await user.click(scope.getByRole('button', { name: 'Accept' }));
    await user.click(scope.getByRole('button', { name: 'Discard' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
        '/ai/prompts/p-3/accept-proposal',
        '/ai/prompts/p-3/discard-proposal',
      ]),
    );
  });

  it('switching role target reports the choice', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mockApi(routes());
    renderWithProviders(<DiscoveryPrompts roleTargetId="rt-1" onRoleTargetChange={onChange} />);
    const select = await screen.findByLabelText('Role target');
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(2));
    await user.selectOptions(select, 'rt-2');
    expect(onChange).toHaveBeenCalledWith('rt-2');
  });
});
