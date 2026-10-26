import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { meQuery } from '@/lib/auth';
import { mockApi, renderWithProviders } from '@/test/render';
import { TwoFactorStep } from './TwoFactorStep';

const USER = { id: 'u1', email: 'ada@example.com', displayName: 'Ada', isAdmin: false };

describe('TwoFactorStep (login, second step)', () => {
  it('verifies a TOTP code with the pending token and signs in', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ 'POST /auth/2fa/verify': { user: USER } });
    const onSignedIn = vi.fn();
    const { queryClient } = renderWithProviders(
      <TwoFactorStep pendingToken="pt-1" onSignedIn={onSignedIn} onRestart={vi.fn()} />,
    );
    const input = await screen.findByLabelText('Authentication code');
    expect(input).toHaveAttribute('autocomplete', 'one-time-code');
    expect(input).toHaveAttribute('inputmode', 'numeric');
    await user.type(input, '123 456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/auth/2fa/verify',
      body: { pendingToken: 'pt-1', code: '123456' },
    });
    expect(queryClient.getQueryData(meQuery.queryKey)).toEqual(USER);
  });

  it('switches to a recovery code and sends it as recoveryCode', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ 'POST /auth/2fa/verify': { user: USER } });
    renderWithProviders(
      <TwoFactorStep pendingToken="pt-1" onSignedIn={vi.fn()} onRestart={vi.fn()} />,
    );
    await user.click(await screen.findByRole('button', { name: 'Use a recovery code' }));
    expect(screen.queryByLabelText('Authentication code')).toBeNull();
    await user.type(screen.getByLabelText('Recovery code'), 'abcde-fghij');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ pendingToken: 'pt-1', recoveryCode: 'abcde-fghij' });
    // ...and back.
    await user.click(screen.getByRole('button', { name: 'Use your authenticator app' }));
    expect(screen.getByLabelText('Authentication code')).toBeInTheDocument();
  });

  it('shows a wrong code inline and keeps the step', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /auth/2fa/verify': () => ({ status: 401, body: { error: { code: 'invalid_code' } } }),
    });
    const onSignedIn = vi.fn();
    renderWithProviders(
      <TwoFactorStep pendingToken="pt-1" onSignedIn={onSignedIn} onRestart={vi.fn()} />,
    );
    await user.type(await screen.findByLabelText('Authentication code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/code is not valid/i);
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('a spent pending token also sends the user back to the password step', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /auth/2fa/verify': () => ({ status: 401, body: { error: { code: 'token_used' } } }),
    });
    const onRestart = vi.fn();
    renderWithProviders(
      <TwoFactorStep pendingToken="pt-1" onSignedIn={vi.fn()} onRestart={onRestart} />,
    );
    await user.type(await screen.findByLabelText('Authentication code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(onRestart).toHaveBeenCalled());
  });

  it('an expired pending token sends the user back to the password step', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /auth/2fa/verify': () => ({
        status: 401,
        body: { error: { code: 'invalid_pending' } },
      }),
    });
    const onRestart = vi.fn();
    renderWithProviders(
      <TwoFactorStep pendingToken="pt-1" onSignedIn={vi.fn()} onRestart={onRestart} />,
    );
    await user.type(await screen.findByLabelText('Authentication code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(onRestart).toHaveBeenCalledWith(expect.stringMatching(/again/i)));
  });

  it('refuses to submit a malformed code', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({});
    renderWithProviders(
      <TwoFactorStep pendingToken="pt-1" onSignedIn={vi.fn()} onRestart={vi.fn()} />,
    );
    await user.type(await screen.findByLabelText('Authentication code'), '12ab');
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/6-digit code/);
    expect(calls).toHaveLength(0);
  });
});
