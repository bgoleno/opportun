import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { RegistrationCard, UsersCard } from './-users';

const NOW = Date.UTC(2026, 9, 17, 12);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const USERS = [
  {
    id: 'admin-1',
    email: 'admin@example.com',
    displayName: 'Ada Admin',
    isAdmin: true,
    totpEnabled: true,
    createdAt: NOW - 86_400_000,
    lastSeenAt: NOW - 3_600_000,
  },
  {
    id: 'member-1',
    email: 'bob@example.com',
    displayName: 'Bob Member',
    isAdmin: false,
    totpEnabled: false,
    createdAt: NOW,
    lastSeenAt: null,
  },
];
const TEMP = 'Tmp-Password-From-Server-123456';
const ADMIN_PASSWORD = 'the-admins-own-password';

describe('UsersCard', () => {
  it('lists accounts with role and 2FA, and offers no reset on your own row', async () => {
    mockApi({ 'GET /admin/users': { items: USERS } });
    renderWithProviders(<UsersCard currentUserId="admin-1" />);
    const table = await screen.findByRole('table', { name: 'Accounts' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Ada Admin');
    expect(rows[0]).toHaveTextContent('admin@example.com');
    expect(rows[0]).toHaveTextContent('Administrator');
    expect(rows[0]).toHaveTextContent('2FA on');
    expect(rows[1]).toHaveTextContent('Member');
    expect(rows[1]).toHaveTextContent('2FA off');
    // Issue #281: a relative last-session time, and an explicit "Never" rather than a blank
    // cell for an account that has not signed in.
    expect(rows[0]).toHaveTextContent('hour ago');
    expect(rows[1]).toHaveTextContent('Never');
    expect(within(rows[0]!).queryByRole('button', { name: /Reset password/ })).toBeNull();
    expect(
      within(rows[1]!).getByRole('button', { name: 'Reset password for Bob Member' }),
    ).toBeInTheDocument();
  });

  it('resets after confirmation and shows the temporary password once', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /admin/users': { items: USERS },
      'POST /admin/users/member-1/reset-password': { temporaryPassword: TEMP },
    });
    renderWithProviders(<UsersCard currentUserId="admin-1" />);
    await user.click(await screen.findByRole('button', { name: 'Reset password for Bob Member' }));
    const confirm = await screen.findByRole('dialog', { name: 'Confirm your password' });
    expect(confirm).toHaveTextContent(/Bob Member/);
    expect(confirm).toHaveTextContent(/signs them out everywhere/);
    expect(confirm).toHaveTextContent(/two-factor/i);
    // Nothing is sent until the admin has typed their own password (issue #10).
    await user.click(within(confirm).getByRole('button', { name: 'Continue' }));
    expect(await within(confirm).findByText('Enter your current password.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await user.type(within(confirm).getByLabelText('Current password'), ADMIN_PASSWORD);
    await user.click(within(confirm).getByRole('button', { name: 'Continue' }));

    const shown = await screen.findByRole('dialog', { name: 'Temporary password' });
    expect(within(shown).getByLabelText('Temporary password for Bob Member')).toHaveValue(TEMP);
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: write },
      configurable: true,
    });
    await user.click(within(shown).getByRole('button', { name: 'Copy temporary password' }));
    expect(write).toHaveBeenCalledWith(TEMP);
    await user.click(within(shown).getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Temporary password' })).toBeNull(),
    );
    expect(document.body.innerHTML).not.toContain(TEMP);
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ password: ADMIN_PASSWORD });
    // The admin's own password does not outlive the dialog either.
    expect(document.body.innerHTML).not.toContain(ADMIN_PASSWORD);
  });

  it('keeps the dialog open with an inline message for a wrong password, and shows no temporary password', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /admin/users': { items: USERS },
      'POST /admin/users/member-1/reset-password': () => ({
        status: 403,
        body: { error: { code: 'invalid_password' } },
      }),
    });
    renderWithProviders(<UsersCard currentUserId="admin-1" />);
    await user.click(await screen.findByRole('button', { name: 'Reset password for Bob Member' }));
    const confirm = await screen.findByRole('dialog', { name: 'Confirm your password' });
    await user.type(within(confirm).getByLabelText('Current password'), 'wrong-password');
    await user.click(within(confirm).getByRole('button', { name: 'Continue' }));
    expect(await within(confirm).findByText('That is not your current password.')).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Temporary password' })).toBeNull();
  });
});

describe('RegistrationCard', () => {
  it('shows the current state and toggles it once the password is confirmed', async () => {
    const user = userEvent.setup();
    let open = false;
    const { calls } = mockApi({
      'GET /admin/registration': () => ({ open }),
      'PATCH /admin/registration': (call: ApiCall) => {
        open = (call.body as { open: boolean }).open;
        return { open };
      },
    });
    renderWithProviders(<RegistrationCard />);
    expect(await screen.findByText('Registration is closed.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open registration' }));
    const confirm = await screen.findByRole('dialog', { name: 'Confirm your password' });
    expect(confirm).toHaveTextContent(/Opening registration/);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    await user.type(within(confirm).getByLabelText('Current password'), ADMIN_PASSWORD);
    await user.click(within(confirm).getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Registration is open.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      open: true,
      password: ADMIN_PASSWORD,
    });
    expect(screen.getByRole('button', { name: 'Close registration' })).toBeInTheDocument();
  });

  it('leaves registration as it was when the password is wrong', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /admin/registration': () => ({ open: false }),
      'PATCH /admin/registration': () => ({
        status: 403,
        body: { error: { code: 'invalid_password' } },
      }),
    });
    renderWithProviders(<RegistrationCard />);
    await user.click(await screen.findByRole('button', { name: 'Open registration' }));
    const confirm = await screen.findByRole('dialog', { name: 'Confirm your password' });
    await user.type(within(confirm).getByLabelText('Current password'), 'wrong-password');
    await user.click(within(confirm).getByRole('button', { name: 'Continue' }));
    expect(await within(confirm).findByText('That is not your current password.')).toBeVisible();
    expect(screen.getByText('Registration is closed.')).toBeInTheDocument();
  });
});
