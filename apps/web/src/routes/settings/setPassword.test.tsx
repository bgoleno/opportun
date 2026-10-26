import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { SetPasswordCard } from './-setPassword';

const NEW_PW = 'my first real password';
const NOW = Date.UTC(2026, 9, 17, 12);
const AUTH = 'https://github.com/login/oauth/authorize?state=s';

function api(over: Record<string, unknown> = {}) {
  let hasPassword = false;
  return mockApi({
    'GET /auth/2fa': () => ({ enabled: false, recoveryCodesLeft: 0, hasPassword }),
    'GET /auth/oauth/accounts': () => ({
      hasPassword,
      accounts: [{ provider: 'github', createdAt: NOW }],
    }),
    'POST /auth/oauth/github/setpw': { authUrl: AUTH },
    'POST /auth/password': () => {
      hasPassword = true;
      return { status: 204 };
    },
    ...over,
  });
}

describe('SetPasswordCard', () => {
  it('first confirms with a linked provider: no password fields until it comes back', async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const { calls } = api();
    renderWithProviders(<SetPasswordCard navigate={navigate} />);
    expect(await screen.findByText('Set a password')).toBeInTheDocument();
    expect(screen.queryByLabelText('New password')).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Confirm with GitHub' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(AUTH));
    expect(calls.some((c) => c.path === '/auth/password')).toBe(false);
  });

  it('after the round trip, sets the first password with no current one', async () => {
    const user = userEvent.setup();
    const { calls } = api();
    renderWithProviders(<SetPasswordCard flash="setpw_ready" />);
    await user.type(await screen.findByLabelText('New password'), NEW_PW);
    await user.type(screen.getByLabelText('Confirm new password'), 'something else entirely');
    await user.click(screen.getByRole('button', { name: 'Set password' }));
    expect(await screen.findByText('Passwords do not match')).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/auth/password')).toBe(false);
    await user.clear(screen.getByLabelText('Confirm new password'));
    await user.type(screen.getByLabelText('Confirm new password'), NEW_PW);
    await user.click(screen.getByRole('button', { name: 'Set password' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/auth/password')?.body).toEqual({ next: NEW_PW }),
    );
    await waitFor(() => expect(screen.queryByText('Set a password')).toBeNull());
  });

  it('a spent or expired confirmation sends the user back to confirm again', async () => {
    const user = userEvent.setup();
    api({
      'POST /auth/password': () => ({
        status: 403,
        body: { error: { code: 'reauth_required' } },
      }),
    });
    renderWithProviders(<SetPasswordCard flash="setpw_ready" />);
    await user.type(await screen.findByLabelText('New password'), NEW_PW);
    await user.type(screen.getByLabelText('Confirm new password'), NEW_PW);
    await user.click(screen.getByRole('button', { name: 'Set password' }));
    expect(await screen.findByText(/confirmation expired or was already used/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Confirm with GitHub' })).toBeInTheDocument();
    expect(screen.queryByLabelText('New password')).toBeNull();
  });

  it('explains a confirmation with a different provider account', async () => {
    api();
    renderWithProviders(<SetPasswordCard flash="setpw_mismatch" />);
    expect(await screen.findByText(/not the one linked to this account/)).toBeInTheDocument();
  });

  it('renders nothing for an account that has a password', async () => {
    const { calls } = mockApi({
      'GET /auth/2fa': { enabled: false, recoveryCodesLeft: 0, hasPassword: true },
      'GET /auth/oauth/accounts': { hasPassword: true, accounts: [] },
    });
    renderWithProviders(<SetPasswordCard />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(screen.queryByText('Set a password')).toBeNull();
  });
});
