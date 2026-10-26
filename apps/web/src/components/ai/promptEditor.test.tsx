import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import type { PromptVersion } from './api';
import { PromptEditor } from './promptEditor';

const NOW = Date.now();

const SEED: PromptVersion = {
  id: 'seed-1',
  taskKey: 'comms.classify',
  name: 'default',
  body: 'Classify the message.\nUse the role targets.\nReturn JSON.',
  version: 1,
  parentId: null,
  isActive: true,
  isSystem: true,
  proposed: false,
  proposalSummary: null,
  createdAt: NOW - 1000,
};

const V2: PromptVersion = {
  id: 'user-2',
  taskKey: 'comms.classify',
  name: 'default',
  body: 'Classify the message.\nWeigh seniority first.\nReturn JSON.',
  version: 2,
  parentId: 'seed-1',
  isActive: false,
  isSystem: false,
  proposed: false,
  proposalSummary: null,
  createdAt: NOW,
};

function setup(versions: PromptVersion[] = [V2, SEED]) {
  let current = versions;
  const api = mockApi({
    'GET /ai/prompts': () => ({ items: current }),
    'POST /ai/prompts/user-2/activate': () => {
      current = current.map((v) => ({ ...v, isActive: v.id === 'user-2' }));
      return { ...V2, isActive: true };
    },
    'POST /ai/prompts/seed-1/activate': () => {
      current = current.map((v) => ({ ...v, isActive: v.id === 'seed-1' }));
      return SEED;
    },
    'POST /ai/prompts': (call: { body: unknown }) => {
      const body = (call.body as { body: string }).body;
      const v3: PromptVersion = { ...V2, id: 'user-3', version: 3, body, parentId: 'seed-1' };
      current = [v3, ...current];
      return { status: 201, body: v3 };
    },
  });
  renderWithProviders(<PromptEditor taskKey="comms.classify" />);
  return api;
}

describe('PromptEditor', () => {
  it('renders a side-by-side diff of two chosen versions', async () => {
    const user = userEvent.setup();
    setup();
    const from = await screen.findByLabelText('Compare');
    const to = screen.getByLabelText('With');
    await user.selectOptions(from, 'seed-1');
    await user.selectOptions(to, 'user-2');

    const diff = screen.getByRole('table', { name: /differences between v1 and v2/i });
    const removed = within(diff).getByText('Use the role targets.');
    const added = within(diff).getByText('Weigh seniority first.');
    expect(removed.closest('[data-change]')).toHaveAttribute('data-change', 'removed');
    expect(added.closest('[data-change]')).toHaveAttribute('data-change', 'added');
    // Unchanged lines appear on both sides.
    expect(within(diff).getAllByText('Classify the message.')).toHaveLength(2);
    // Removed text sits in the left column, added text in the right.
    const [left, right] = [removed.closest('td'), added.closest('td')];
    expect(left?.cellIndex).toBe(0);
    expect(right?.cellIndex).toBe(1);
  });

  it('activates a version through the activate endpoint and shows it as active', async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    await user.click(await screen.findByRole('button', { name: 'Activate v2' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.path === '/ai/prompts/user-2/activate'),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Activate v2' })).not.toBeInTheDocument(),
    );
    const row = screen.getByRole('row', { name: /v2/ });
    expect(within(row).getByText('Active')).toBeInTheDocument();
  });

  it('reset to default activates the system seed', async () => {
    const user = userEvent.setup();
    const { calls } = setup([
      { ...V2, isActive: true },
      { ...SEED, isActive: false },
    ]);
    await user.click(await screen.findByRole('button', { name: 'Reset to default' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.path === '/ai/prompts/seed-1/activate'),
      ).toBe(true),
    );
  });

  it('saves an edit as a new version', async () => {
    const user = userEvent.setup();
    const { calls } = setup();
    const editor = await screen.findByLabelText('Prompt text');
    expect(editor).toHaveValue(SEED.body); // starts from the active version
    await user.clear(editor);
    await user.type(editor, 'A better prompt');
    await user.click(screen.getByRole('button', { name: 'Save as new version' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.path === '/ai/prompts')?.body).toEqual({
        taskKey: 'comms.classify',
        body: 'A better prompt',
      }),
    );
    expect(await screen.findByRole('button', { name: 'Activate v3' })).toBeInTheDocument();
  });
});
