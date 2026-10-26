import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { ProviderKeysCard } from './ProviderKeysCard';
import type { AiKey } from './api';

const NOW = Date.UTC(2026, 9, 17);

const KEY: AiKey = {
  id: 'k1',
  label: 'anthropic',
  displayName: null,
  expiresAt: null,
  createdAt: NOW - 86_400_000,
  validation: null,
};

describe('ProviderKeysCard delete (issue #74)', () => {
  it('deletes only after confirmation, and closes the dialog once the server has actually removed it', async () => {
    const user = userEvent.setup();
    let items = [KEY];
    mockApi({
      'GET /ai/keys': () => ({ items }),
      'DELETE /secrets/k1': () => {
        items = [];
        return { status: 204 };
      },
    });
    renderWithProviders(<ProviderKeysCard now={NOW} />);

    await user.click(await screen.findByRole('button', { name: 'Remove key Anthropic' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove this key?' });
    await user.click(within(confirm).getByRole('button', { name: 'Remove key' }));

    await screen.findByText(/No keys stored yet\./);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the dialog open and shows the error when the delete fails, instead of closing as if it had succeeded', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /ai/keys': { items: [KEY] },
      'DELETE /secrets/k1': () => ({ status: 500, body: { error: { code: 'server_error' } } }),
    });
    renderWithProviders(<ProviderKeysCard now={NOW} />);

    await user.click(await screen.findByRole('button', { name: 'Remove key Anthropic' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove this key?' });
    await user.click(within(confirm).getByRole('button', { name: 'Remove key' }));

    // The inline alert ConfirmDialog itself now renders on a rejection (#84), not just the toast.
    expect(await within(confirm).findByRole('alert')).toHaveTextContent(/server_error/);
    expect(await screen.findByText('Key not removed')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Remove this key?' })).toBeInTheDocument();
    expect(screen.getByTestId('key-row-k1')).toBeInTheDocument();
  });
});
