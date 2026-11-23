import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { browserCloses, pressEscapeOn } from '@/test/dialog';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { PasswordCard } from './-password';
import { TwoFactorCard } from './-twoFactor';

const QR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const CODES = [
  'AAAAABBBBB',
  'CCCCCDDDDD',
  'EEEEEFFFFF',
  'GGGGGHHHHH',
  'IIIIIJJJJJ',
  'KKKKKLLLLL',
  'MMMMMNNNNN',
  'OOOOOPPPPP',
  'QQQQQRRRRR',
  'SSSSSTTTTT',
];

const PW = 'my current password';

/** Enable two-factor, then confirm the current password. */
async function startEnable(user: ReturnType<typeof userEvent.setup>, password = PW) {
  await user.click(await screen.findByRole('button', { name: 'Enable two-factor' }));
  const confirm = await screen.findByRole('dialog', { name: 'Confirm your password' });
  await user.type(within(confirm).getByLabelText('Current password'), password);
  await user.click(within(confirm).getByRole('button', { name: 'Continue' }));
  return confirm;
}

describe('TwoFactorCard', () => {
  it('shows the off state and enables 2FA: QR from the response, manual secret, code', async () => {
    const user = userEvent.setup();
    let enabled = false;
    const { calls } = mockApi({
      'GET /auth/2fa': () =>
        enabled
          ? { enabled: true, recoveryCodesLeft: 10 }
          : { enabled: false, recoveryCodesLeft: 0 },
      'POST /auth/2fa/enroll': {
        secret: SECRET,
        otpauthUrl: `otpauth://totp/Opportun:ada?secret=${SECRET}`,
        qrDataUrl: QR,
      },
      'POST /auth/2fa/activate': () => {
        enabled = true;
        return { recoveryCodes: CODES };
      },
    });
    renderWithProviders(<TwoFactorCard />);
    expect(await screen.findByText('Off')).toBeInTheDocument();
    await startEnable(user);
    expect(calls.find((c) => c.path === '/auth/2fa/enroll')?.body).toEqual({ password: PW });

    const dialog = await screen.findByRole('dialog', { name: 'Set up two-factor sign-in' });
    const img = within(dialog).getByRole('img', { name: /QR code/ });
    expect(img).toHaveAttribute('src', QR);
    expect(within(dialog).getByLabelText('Setup key')).toHaveValue(SECRET);

    await user.type(within(dialog).getByLabelText('Code from the app'), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/auth/2fa/activate')?.body).toEqual({
        code: '123456',
        password: PW,
      }),
    );

    // Recovery codes, shown once with a copy button; the dialog only closes on confirmation.
    const codes = await screen.findByRole('list', { name: 'Recovery codes' });
    expect(
      within(codes)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(CODES.map((c) => `${c.slice(0, 5)}-${c.slice(5)}`));
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: write },
      configurable: true,
    });
    const done = screen.getByRole('dialog', { name: 'Save your recovery codes' });
    await user.click(within(done).getByRole('button', { name: 'Copy codes' }));
    expect(write).toHaveBeenCalledWith(
      CODES.map((c) => `${c.slice(0, 5)}-${c.slice(5)}`).join('\n'),
    );
    // Neither Escape nor a close the browser makes on its own takes the codes away (#898).
    pressEscapeOn(done);
    expect(screen.getByRole('dialog', { name: 'Save your recovery codes' })).toBe(done);
    browserCloses(done);
    expect(screen.getByRole('dialog', { name: 'Save your recovery codes' })).toBe(done);
    expect(screen.getByRole('list', { name: 'Recovery codes' })).toBeInTheDocument();
    await user.click(within(done).getByRole('button', { name: 'I saved them' }));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Recovery codes' })).toBeNull());
    expect(await screen.findByText('On')).toBeInTheDocument();
    expect(screen.getByText(/10 recovery codes left/)).toBeInTheDocument();
    // Gone for good: nothing on the page shows the codes or the secret any more.
    expect(document.body.textContent).not.toContain(CODES[0]!.slice(0, 5) + '-');
    expect(document.body.textContent).not.toContain(SECRET);
  });

  // https://github.com/bgoleno/opportun/issues/898: closed while activation was in flight, two-factor
  // went on and its recovery codes were never shown.
  describe('while activation is in flight', () => {
    async function inFlight() {
      const user = userEvent.setup();
      let answer!: (body: unknown) => void;
      let enabled = false;
      mockApi({
        'GET /auth/2fa': () => ({ enabled, recoveryCodesLeft: enabled ? 10 : 0 }),
        'POST /auth/2fa/enroll': { secret: SECRET, otpauthUrl: 'otpauth://x', qrDataUrl: QR },
        'POST /auth/2fa/activate': () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      });
      renderWithProviders(<TwoFactorCard />);
      await startEnable(user);
      const dialog = await screen.findByRole('dialog', { name: 'Set up two-factor sign-in' });
      await user.type(within(dialog).getByLabelText('Code from the app'), '123456');
      await user.click(within(dialog).getByRole('button', { name: 'Turn on' }));
      await within(dialog).findByRole('button', { name: 'Turning on...' });
      return {
        user,
        dialog,
        succeed: () => {
          enabled = true;
          answer({ recoveryCodes: CODES });
        },
        fail: () => answer({ status: 403, body: { error: { code: 'invalid_code' } } }),
      };
    }

    it('nothing closes the dialog, and the codes are shown', async () => {
      const { user, dialog, succeed } = await inFlight();
      const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
      expect(cancel).toBeDisabled();
      await user.click(cancel);
      expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull();
      await user.click(dialog); // the backdrop
      pressEscapeOn(dialog);
      expect(screen.getByRole('dialog', { name: 'Set up two-factor sign-in' })).toBe(dialog);
      browserCloses(dialog);
      expect(screen.getByRole('dialog', { name: 'Set up two-factor sign-in' })).toBe(dialog);

      succeed();
      const codes = await screen.findByRole('list', { name: 'Recovery codes' });
      expect(within(codes).getAllByRole('listitem')).toHaveLength(CODES.length);
    });

    it('the card says On as soon as it succeeds, before the codes are put away', async () => {
      const { succeed } = await inFlight();
      expect(screen.getByText('Off')).toBeInTheDocument();
      succeed();
      await screen.findByRole('list', { name: 'Recovery codes' });
      expect(await screen.findByText('On')).toBeInTheDocument();
      expect(screen.queryByText('Off')).toBeNull();
      expect(screen.getByRole('list', { name: 'Recovery codes' })).toBeInTheDocument();
    });

    it('once it has failed, the dialog can be left again', async () => {
      const { dialog, fail } = await inFlight();
      fail();
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(/not valid/i);
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
      expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
      pressEscapeOn(dialog);
      expect(screen.queryByRole('dialog', { name: 'Set up two-factor sign-in' })).toBeNull();
    });
  });

  it('a wrong activation code is shown and the dialog stays open', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /auth/2fa': { enabled: false, recoveryCodesLeft: 0 },
      'POST /auth/2fa/enroll': { secret: SECRET, otpauthUrl: 'otpauth://x', qrDataUrl: QR },
      'POST /auth/2fa/activate': () => ({ status: 403, body: { error: { code: 'invalid_code' } } }),
    });
    renderWithProviders(<TwoFactorCard />);
    await startEnable(user);
    const dialog = await screen.findByRole('dialog', { name: 'Set up two-factor sign-in' });
    await user.type(within(dialog).getByLabelText('Code from the app'), '000000');
    await user.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/not valid/i);
    expect(screen.queryByRole('list', { name: 'Recovery codes' })).toBeNull();
  });

  it('an enroll failure is reported in the password dialog; no setup dialog opens', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /auth/2fa': { enabled: false, recoveryCodesLeft: 0 },
      'POST /auth/2fa/enroll': () => ({
        status: 409,
        body: { error: { code: 'already_enabled' } },
      }),
    });
    renderWithProviders(<TwoFactorCard />);
    const confirm = await startEnable(user);
    expect(await within(confirm).findByRole('alert')).toHaveTextContent(/already on/i);
    expect(screen.queryByRole('dialog', { name: 'Set up two-factor sign-in' })).toBeNull();
  });

  it('a wrong current password keeps the password dialog with an error', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /auth/2fa': { enabled: false, recoveryCodesLeft: 0 },
      'POST /auth/2fa/enroll': () => ({
        status: 403,
        body: { error: { code: 'invalid_password' } },
      }),
    });
    renderWithProviders(<TwoFactorCard />);
    const confirm = await startEnable(user, 'wrong');
    expect(await within(confirm).findByRole('alert')).toHaveTextContent(
      'That is not your current password.',
    );
    expect(screen.queryByRole('dialog', { name: 'Set up two-factor sign-in' })).toBeNull();
  });

  it('without a password, 2FA cannot be enabled yet and says why', async () => {
    mockApi({ 'GET /auth/2fa': { enabled: false, recoveryCodesLeft: 0, hasPassword: false } });
    renderWithProviders(<TwoFactorCard />);
    expect(await screen.findByRole('button', { name: 'Enable two-factor' })).toBeDisabled();
    expect(screen.getByText(/Set a password first/)).toBeInTheDocument();
  });

  it('disables with a code, or with a recovery code', async () => {
    const user = userEvent.setup();
    let enabled = true;
    const { calls } = mockApi({
      'GET /auth/2fa': () =>
        enabled
          ? { enabled: true, recoveryCodesLeft: 3 }
          : { enabled: false, recoveryCodesLeft: 0 },
      'POST /auth/2fa/disable': (call: ApiCall) => {
        if ((call.body as { code?: string }).code === '000000') {
          return { status: 403, body: { error: { code: 'invalid_code' } } };
        }
        enabled = false;
        return { status: 204 };
      },
    });
    renderWithProviders(<TwoFactorCard />);
    expect(await screen.findByText('On')).toBeInTheDocument();
    expect(screen.getByText(/3 recovery codes left/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Turn off' }));
    const dialog = await screen.findByRole('dialog', { name: 'Turn off two-factor sign-in' });
    await user.type(within(dialog).getByLabelText('Current password'), PW);
    await user.type(within(dialog).getByLabelText('Authentication code'), '000000');
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/not valid/i);

    await user.click(within(dialog).getByRole('button', { name: 'Use a recovery code' }));
    await user.type(within(dialog).getByLabelText('Recovery code'), 'AAAAA-BBBBB');
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(screen.getByText('Off')).toBeInTheDocument());
    expect(calls.filter((c) => c.path === '/auth/2fa/disable').at(-1)?.body).toEqual({
      recoveryCode: 'AAAAA-BBBBB',
      password: PW,
    });
  });
});

// #523 (sec's audit): changing the password can also revoke the user's device tokens, checked by
// default, with the effect stated: the browser extension and the Mail connector pair again.
describe('PasswordCard: device tokens (#523)', () => {
  async function change(user: ReturnType<typeof userEvent.setup>) {
    await user.type(await screen.findByLabelText('Current password'), PW);
    await user.type(screen.getByLabelText('New password'), 'a brand new passphrase');
    await user.type(screen.getByLabelText('Confirm new password'), 'a brand new passphrase');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
  }

  it('offers to sign out the extension and Mail connector, checked by default, and sends it', async () => {
    const api = mockApi({ 'POST /auth/password': { status: 204 } });
    const user = userEvent.setup();
    renderWithProviders(<PasswordCard email="ada@example.com" />);
    const box = await screen.findByRole('checkbox', {
      name: 'Also sign out the browser extension and the Mail connector',
    });
    expect(box).toBeChecked();
    expect(
      screen.getByText(/revokes their device tokens: pair them again from Settings/),
    ).toBeInTheDocument();
    await change(user);
    await waitFor(() =>
      expect(api.calls.find((c: ApiCall) => c.path === '/auth/password')?.body).toEqual({
        current: PW,
        next: 'a brand new passphrase',
        revokeDeviceTokens: true,
      }),
    );
    // Worded so it is true whether or not any were paired (tl on #536).
    expect(
      await screen.findByText(
        /Any browser extension or Mail connector you had paired needs pairing again/,
      ),
    ).toBeInTheDocument();
  });

  it('unchecked, it keeps them and says so', async () => {
    const api = mockApi({ 'POST /auth/password': { status: 204 } });
    const user = userEvent.setup();
    renderWithProviders(<PasswordCard email="ada@example.com" />);
    await user.click(
      await screen.findByRole('checkbox', {
        name: 'Also sign out the browser extension and the Mail connector',
      }),
    );
    await change(user);
    await waitFor(() =>
      expect(api.calls.find((c: ApiCall) => c.path === '/auth/password')?.body).toMatchObject({
        revokeDeviceTokens: false,
      }),
    );
    expect(await screen.findByText('Other devices have been signed out.')).toBeInTheDocument();
  });
});
