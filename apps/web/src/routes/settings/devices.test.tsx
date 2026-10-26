import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { DevicesCard, relativeTime } from './-devices';

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const MIN = 60_000;
const TOKEN = `odt_${'A'.repeat(43)}`;
const PW = 'my current password';

interface Meta {
  id: string;
  name: string;
  scopes: string[];
  lastUsedAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

const LAPTOP: Meta = {
  id: 't1',
  name: 'MacBook connector',
  scopes: ['mail:push'],
  lastUsedAt: NOW - 5 * MIN,
  revokedAt: null,
  createdAt: NOW - 3 * 24 * 60 * MIN,
};
const OLD: Meta = {
  id: 't0',
  name: 'Old laptop',
  scopes: ['mail:push', 'capture:push'],
  lastUsedAt: null,
  revokedAt: NOW - 60 * MIN,
  createdAt: NOW - 30 * 24 * 60 * MIN,
};

const NOT_CONNECTED = {
  connected: false,
  lastSyncAt: null,
  status: null,
  count: 0,
  staleHint: null,
};
const STALE_HINT =
  'No mail from the connector in over 24 hours. Check that it is running on your Mac.';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('relativeTime', () => {
  it('reads like a person would say it', () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe('just now');
    expect(relativeTime(NOW - 5 * MIN, NOW)).toBe('5 minutes ago');
    expect(relativeTime(NOW - 2 * 60 * MIN, NOW)).toBe('2 hours ago');
    expect(relativeTime(NOW - 24 * 60 * MIN, NOW)).toBe('yesterday');
    expect(relativeTime(NOW - 3 * 24 * 60 * MIN, NOW)).toBe('3 days ago');
  });
});

describe('DevicesCard', () => {
  it('lists tokens with scopes, created, last used and revoked state', async () => {
    mockApi({
      'GET /device-tokens': { items: [LAPTOP, OLD] },
      'GET /integrations/apple-mail': NOT_CONNECTED,
    });
    renderWithProviders(<DevicesCard />);
    const list = await screen.findByRole('list', { name: 'Device tokens' });
    const laptop = within(list).getByRole('listitem', { name: 'MacBook connector' });
    expect(within(laptop).getByText('Apple Mail connector (mail:push)')).toBeInTheDocument();
    expect(within(laptop).getByText(/Created 3 days ago/)).toBeInTheDocument();
    expect(within(laptop).getByText(/Last used 5 minutes ago/)).toBeInTheDocument();
    expect(within(laptop).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();

    const old = within(list).getByRole('listitem', { name: 'Old laptop' });
    expect(within(old).getByText('Revoked')).toBeInTheDocument();
    expect(within(old).getByText(/Never used/)).toBeInTheDocument();
    expect(within(old).getByText('Browser capture (capture:push)')).toBeInTheDocument();
    expect(within(old).queryByRole('button', { name: 'Revoke' })).toBeNull();
    // Nothing secret is ever listed.
    expect(document.body.textContent).not.toContain('odt_');
  });

  it('shows Apple Mail as not connected until the connector has pushed a batch', async () => {
    mockApi({
      'GET /device-tokens': { items: [] },
      'GET /integrations/apple-mail': NOT_CONNECTED,
    });
    renderWithProviders(<DevicesCard />);
    expect(await screen.findByText(/Apple Mail: not connected/)).toBeInTheDocument();
    expect(screen.getByText(/No device tokens yet/)).toBeInTheDocument();
  });

  it('shows Apple Mail as connected with the time of the last batch', async () => {
    mockApi({
      'GET /device-tokens': { items: [LAPTOP] },
      'GET /integrations/apple-mail': {
        connected: true,
        lastSyncAt: NOW - 2 * 60 * MIN,
        status: 'ok',
        count: 12,
        staleHint: null,
      },
    });
    renderWithProviders(<DevicesCard />);
    expect(
      await screen.findByText('Apple Mail: connected, last batch 2 hours ago (12 messages).'),
    ).toBeInTheDocument();
  });

  it('shows the server staleness hint under a connected line', async () => {
    mockApi({
      'GET /device-tokens': { items: [LAPTOP] },
      'GET /integrations/apple-mail': {
        connected: true,
        lastSyncAt: NOW - 3 * 24 * 60 * MIN,
        status: 'ok',
        count: 12,
        staleHint: STALE_HINT,
      },
    });
    renderWithProviders(<DevicesCard />);
    expect(await screen.findByText(/Apple Mail: connected, last batch 3 days ago/)).toBeVisible();
    expect(screen.getByText(STALE_HINT)).toBeVisible();
  });

  it('with mail history but no active Apple Mail token, says it is disconnected and when it last synced', async () => {
    mockApi({
      'GET /device-tokens': { items: [OLD] },
      'GET /integrations/apple-mail': {
        connected: false,
        lastSyncAt: NOW - 2 * 60 * MIN,
        status: 'ok',
        count: 12,
        staleHint: null,
      },
    });
    renderWithProviders(<DevicesCard />);
    expect(
      await screen.findByText(
        /Apple Mail: not connected \(no active token; last batch 2 hours ago\)/,
      ),
    ).toBeVisible();
    expect(screen.queryByText(/Apple Mail: connected/)).toBeNull();
  });

  it('creates a token with name, scopes and the current password, then shows it exactly once', async () => {
    const user = userEvent.setup();
    let items: Meta[] = [];
    const { calls } = mockApi({
      'GET /device-tokens': () => ({ items }),
      'GET /integrations/apple-mail': NOT_CONNECTED,
      'POST /device-tokens': (call: ApiCall) => {
        const body = call.body as { name: string; scopes: string[] };
        const meta = {
          ...LAPTOP,
          id: 't9',
          name: body.name,
          scopes: body.scopes,
          lastUsedAt: null,
        };
        items = [meta];
        return { status: 201, body: { ...meta, token: TOKEN } };
      },
    });
    renderWithProviders(<DevicesCard />);
    await user.click(await screen.findByRole('button', { name: 'Create token' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create a device token' });
    await user.type(within(dialog).getByLabelText('Name'), 'Work MacBook');
    // Apple Mail is preselected; add browser capture as well.
    expect(within(dialog).getByRole('checkbox', { name: /Apple Mail connector/ })).toBeChecked();
    await user.click(within(dialog).getByRole('checkbox', { name: /Browser capture/ }));
    await user.type(within(dialog).getByLabelText('Current password'), PW);
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.path === '/device-tokens')?.body).toEqual({
        name: 'Work MacBook',
        scopes: ['mail:push', 'capture:push'],
        password: PW,
      }),
    );
    const shown = await screen.findByRole('dialog', { name: 'Copy your device token' });
    expect(within(shown).getByLabelText('Device token')).toHaveValue(TOKEN);
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: write },
      configurable: true,
    });
    await user.click(within(shown).getByRole('button', { name: 'Copy token' }));
    expect(write).toHaveBeenCalledWith(TOKEN);
    // Escape does not dismiss it: closing is only through the explicit confirmation.
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Copy your device token' })).toBeInTheDocument();
    await user.click(within(shown).getByRole('button', { name: 'I saved it' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Copy your device token' })).toBeNull(),
    );
    expect(
      await within(screen.getByRole('list', { name: 'Device tokens' })).findByRole('listitem', {
        name: 'Work MacBook',
      }),
    ).toBeInTheDocument();
    // Gone for good: the plaintext is nowhere on the page any more.
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it('validates the dialog: a name, at least one scope and the password are required', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /device-tokens': { items: [] },
      'GET /integrations/apple-mail': NOT_CONNECTED,
    });
    renderWithProviders(<DevicesCard />);
    await user.click(await screen.findByRole('button', { name: 'Create token' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create a device token' });
    await user.click(within(dialog).getByRole('checkbox', { name: /Apple Mail connector/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(within(dialog).getByText('Give the token a name.')).toBeInTheDocument();
    expect(within(dialog).getByText('Pick at least one permission.')).toBeInTheDocument();
    expect(within(dialog).getByText('Enter your current password.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('a wrong current password keeps the dialog open with an error and shows no token', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /device-tokens': { items: [] },
      'GET /integrations/apple-mail': NOT_CONNECTED,
      'POST /device-tokens': () => ({ status: 403, body: { error: { code: 'invalid_password' } } }),
    });
    renderWithProviders(<DevicesCard />);
    await user.click(await screen.findByRole('button', { name: 'Create token' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create a device token' });
    await user.type(within(dialog).getByLabelText('Name'), 'Work MacBook');
    await user.type(within(dialog).getByLabelText('Current password'), 'wrong');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText('That is not your current password.')).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Copy your device token' })).toBeNull();
  });

  it('revokes a token only after confirmation', async () => {
    const user = userEvent.setup();
    let items: Meta[] = [LAPTOP];
    const { calls } = mockApi({
      'GET /device-tokens': () => ({ items }),
      'GET /integrations/apple-mail': NOT_CONNECTED,
      'DELETE /device-tokens/t1': () => {
        items = [{ ...LAPTOP, revokedAt: NOW }];
        return { status: 204 };
      },
    });
    renderWithProviders(<DevicesCard />);
    const row = await screen.findByRole('listitem', { name: 'MacBook connector' });
    await user.click(within(row).getByRole('button', { name: 'Revoke' }));
    const confirm = await screen.findByRole('dialog', { name: 'Revoke MacBook connector?' });
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    await user.click(within(row).getByRole('button', { name: 'Revoke' }));
    const again = await screen.findByRole('dialog', { name: 'Revoke MacBook connector?' });
    await user.click(within(again).getByRole('button', { name: 'Revoke' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([
        '/device-tokens/t1',
      ]),
    );
    expect(await within(row).findByText('Revoked')).toBeInTheDocument();
    // Revoking can disconnect Apple Mail, so its status is fetched again.
    await waitFor(() =>
      expect(calls.filter((c) => c.path === '/integrations/apple-mail').length).toBe(2),
    );
  });

  describe('browser extension row (design D15, D23)', () => {
    it('says so before anyone mints a token when the server has no download', async () => {
      mockApi({
        'GET /device-tokens': { items: [] },
        'GET /integrations/apple-mail': NOT_CONNECTED,
        'GET /artifacts/extension': {
          baseUrl: 'http://localhost:8080',
          buildCommand: 'pnpm --filter @opportun/extension build',
          targets: [
            {
              id: 'chrome',
              label: 'Chrome, Edge, Brave',
              filename: 'c.zip',
              available: false,
              buildStamp: null,
            },
            {
              id: 'firefox',
              label: 'Firefox',
              filename: 'f.zip',
              available: false,
              buildStamp: null,
            },
          ],
        },
      });
      renderWithProviders(<DevicesCard />);
      // D15: the card says it, rather than the user discovering it after confirming a password
      // and holding a token they now have to store or revoke.
      expect(
        await screen.findByText(/pnpm --filter @opportun\/extension build/),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /set up/i })).toBeDisabled();
    });

    const row = () => screen.getByRole('listitem', { name: /browser extension/i });

    it('reads as not set up without a capture token', async () => {
      mockApi({
        'GET /device-tokens': { items: [LAPTOP] },
        'GET /integrations/apple-mail': NOT_CONNECTED,
      });
      renderWithProviders(<DevicesCard />);
      expect(await screen.findByRole('listitem', { name: /browser extension/i })).toHaveTextContent(
        /not set up/i,
      );
    });

    it('reads as waiting while an unused capture token exists', async () => {
      const unused = {
        ...LAPTOP,
        id: 'c1',
        name: 'Chrome',
        scopes: ['capture:push'],
        lastUsedAt: null,
      };
      mockApi({
        'GET /device-tokens': { items: [unused] },
        'GET /integrations/apple-mail': NOT_CONNECTED,
      });
      renderWithProviders(<DevicesCard />);
      // The row renders before the token list arrives, so wait for the text the data decides.
      expect(await screen.findByText(/waiting for its first capture/i)).toBeInTheDocument();
    });

    it('reads as set up once a capture token has been used, and stays addable', async () => {
      const used = { ...LAPTOP, id: 'c1', name: 'Chrome', scopes: ['capture:push'] };
      mockApi({
        'GET /device-tokens': { items: [used] },
        'GET /integrations/apple-mail': NOT_CONNECTED,
      });
      renderWithProviders(<DevicesCard />);
      expect(await screen.findByText(/last capture/i)).toBeInTheDocument();
      // A second browser is a normal thing to add, so Set up never disappears.
      expect(within(row()).getByRole('button', { name: /set up/i })).toBeInTheDocument();
    });

    it('ignores a revoked capture token', async () => {
      mockApi({
        'GET /device-tokens': { items: [OLD] },
        'GET /integrations/apple-mail': NOT_CONNECTED,
      });
      renderWithProviders(<DevicesCard />);
      // Wait for the list to arrive, then confirm the revoked token changed nothing.
      await screen.findByRole('listitem', { name: 'Old laptop' });
      expect(row()).toHaveTextContent(/not set up/i);
    });
  });
});
