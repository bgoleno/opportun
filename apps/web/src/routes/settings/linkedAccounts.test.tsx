import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { LinkedAccountsCard } from './-linkedAccounts';

const NOW = Date.UTC(2026, 9, 17, 12);

describe('LinkedAccountsCard', () => {
  it('lists configured providers with Link or Unlink', async () => {
    mockApi({
      'GET /auth/oauth/providers': { providers: ['google', 'github'] },
      'GET /auth/oauth/accounts': {
        hasPassword: true,
        accounts: [{ provider: 'github', createdAt: NOW }],
      },
    });
    renderWithProviders(<LinkedAccountsCard />);
    const github = await screen.findByRole('listitem', { name: 'GitHub' });
    expect(github).toHaveTextContent('Linked');
    expect(within(github).getByRole('button', { name: 'Unlink GitHub' })).toBeInTheDocument();
    const google = screen.getByRole('listitem', { name: 'Google' });
    expect(within(google).getByRole('button', { name: 'Link Google' })).toBeEnabled();
  });

  it('links only after confirming the current password, then goes to the provider', async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const AUTH = 'https://github.com/login/oauth/authorize?state=s';
    const { calls } = mockApi({
      'GET /auth/oauth/providers': { providers: ['github'] },
      'GET /auth/oauth/accounts': { hasPassword: true, accounts: [] },
      'POST /auth/oauth/github/link': (call: ApiCall) =>
        (call.body as { password: string }).password === 'right password'
          ? { authUrl: AUTH }
          : { status: 403, body: { error: { code: 'invalid_password' } } },
    });
    renderWithProviders(<LinkedAccountsCard navigate={navigate} />);
    await user.click(await screen.findByRole('button', { name: 'Link GitHub' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm your password' });
    await user.type(within(dialog).getByLabelText('Current password'), 'wrong');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(await within(dialog).findByText('That is not your current password.')).toBeVisible();
    expect(navigate).not.toHaveBeenCalled();
    await user.clear(within(dialog).getByLabelText('Current password'));
    await user.type(within(dialog).getByLabelText('Current password'), 'right password');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(AUTH));
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
      { password: 'wrong' },
      { password: 'right password' },
    ]);
  });

  it('unlinks after confirming the current password', async () => {
    const user = userEvent.setup();
    let linked = true;
    const { calls } = mockApi({
      'GET /auth/oauth/providers': { providers: ['github'] },
      'GET /auth/oauth/accounts': () => ({
        hasPassword: true,
        accounts: linked ? [{ provider: 'github', createdAt: NOW }] : [],
      }),
      'DELETE /auth/oauth/github': (call: ApiCall) => {
        if ((call.body as { password?: string }).password !== 'right password') {
          return { status: 403, body: { error: { code: 'invalid_password' } } };
        }
        linked = false;
        return { status: 204 };
      },
    });
    renderWithProviders(<LinkedAccountsCard />);
    await user.click(await screen.findByRole('button', { name: 'Unlink GitHub' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm your password' });
    await user.type(within(dialog).getByLabelText('Current password'), 'wrong');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(await within(dialog).findByText('That is not your current password.')).toBeVisible();
    await user.clear(within(dialog).getByLabelText('Current password'));
    await user.type(within(dialog).getByLabelText('Current password'), 'right password');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.body)).toEqual([
      { password: 'wrong' },
      { password: 'right password' },
    ]);
    expect(await screen.findByRole('button', { name: 'Link GitHub' })).toBeInTheDocument();
  });

  it('without a password, cannot link and explains the last-method refusal', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /auth/oauth/providers': { providers: ['github', 'google'] },
      'GET /auth/oauth/accounts': {
        hasPassword: false,
        accounts: [{ provider: 'github', createdAt: NOW }],
      },
      'DELETE /auth/oauth/github': () => ({
        status: 409,
        body: { error: { code: 'last_method' } },
      }),
    });
    renderWithProviders(<LinkedAccountsCard />);
    expect(await screen.findByRole('button', { name: 'Link Google' })).toBeDisabled();
    expect(screen.getByText(/Set a password above to link/)).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Unlink GitHub' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unlink GitHub?' });
    await user.click(within(dialog).getByRole('button', { name: 'Unlink' }));
    expect(await screen.findByText(/only way to sign in/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'DELETE')?.body).toEqual({});
  });

  it('shows the result of a link round trip from the flash', async () => {
    mockApi({
      'GET /auth/oauth/providers': { providers: ['github'] },
      'GET /auth/oauth/accounts': { hasPassword: true, accounts: [] },
    });
    renderWithProviders(<LinkedAccountsCard flash="conflict" />);
    expect(await screen.findByText(/already linked to another account/)).toBeInTheDocument();
  });

  it('hides itself when no provider is configured', async () => {
    const { calls } = mockApi({
      'GET /auth/oauth/providers': { providers: [] },
      'GET /auth/oauth/accounts': { hasPassword: true, accounts: [] },
    });
    renderWithProviders(<LinkedAccountsCard />);
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByText('Linked accounts')).toBeNull();
  });
});
