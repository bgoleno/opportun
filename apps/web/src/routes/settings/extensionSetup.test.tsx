// The guided setup flow (design D2, D4, D6, D7, D8, D11, D15, D20, D23, D24): one dialog that
// mints the scoped token, hands over the matching download, and keeps the token on screen for
// as long as the install takes.
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { ExtensionSetupDialog } from './-extensionSetup';

const TOKEN = `odt_${'A'.repeat(43)}`;

const TARGETS = {
  baseUrl: 'http://nas.local:8080',
  targets: [
    {
      id: 'chrome',
      label: 'Chrome, Edge, Brave',
      filename: 'opportun-chrome-0.1.0.zip',
      available: true,
      buildStamp: '0.1.0+abc12345 (d4c5383, 2026-10-21T05:19:32.775Z)',
    },
    {
      id: 'firefox',
      label: 'Firefox',
      filename: 'opportun-firefox-0.1.0.zip',
      available: true,
      buildStamp: null,
    },
  ],
  buildCommand: 'pnpm --filter @opportun/extension build',
};

const created = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  name: 'Chrome · Alex',
  scopes: ['capture:push'],
  lastUsedAt: null,
  revokedAt: null,
  createdAt: Date.now(),
  token: TOKEN,
  ...over,
});

function show(routes: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
  const { calls } = mockApi({
    'GET /artifacts/extension': TARGETS,
    'GET /auth/2fa': { enabled: false, recoveryCodesLeft: 0, hasPassword: true },
    'GET /device-tokens': { items: [] },
    'POST /device-tokens': () => ({ status: 201, body: created() }),
    ...routes,
  });
  renderWithProviders(
    <ExtensionSetupDialog open onOpenChange={() => {}} displayName="Alex" pollMs={10} {...props} />,
  );
  return { calls };
}

async function mint(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText(/password/i), 'correct horse battery');
  await user.click(screen.getByRole('button', { name: /continue/i }));
}

describe('ExtensionSetupDialog', () => {
  it('asks only for the password, with no name to invent', async () => {
    show();
    expect(await screen.findByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^name$/i)).not.toBeInTheDocument();
  });

  it('tells an account with no password to set one, instead of a field that cannot work', async () => {
    show({ 'GET /auth/2fa': { enabled: false, recoveryCodesLeft: 0, hasPassword: false } });
    expect(await screen.findByText(/set a password/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });

  it('mints on the password step and shows the token in full', async () => {
    const user = userEvent.setup();
    const { calls } = show();
    await mint(user);
    expect(await screen.findByText(TOKEN)).toBeInTheDocument();
    const post = calls.find((c) => c.method === 'POST' && c.path === '/device-tokens');
    expect(post?.body).toMatchObject({ name: 'Chrome · Alex', scopes: ['capture:push'] });
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
  });

  it('only says the token was copied once the clipboard write actually succeeds (#150)', async () => {
    const user = userEvent.setup();
    show();
    await mint(user);
    await screen.findByText(TOKEN);
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: write },
      configurable: true,
    });

    await user.click(screen.getByRole('button', { name: /copy/i }));

    expect(write).toHaveBeenCalledWith(TOKEN);
    expect(await screen.findByText('Token copied')).toBeInTheDocument();
  });

  it('reports a failed copy instead of claiming success, same as the device-token and 2FA flows', async () => {
    const user = userEvent.setup();
    show();
    await mint(user);
    await screen.findByText(TOKEN);
    const write = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: write },
      configurable: true,
    });

    await user.click(screen.getByRole('button', { name: /copy/i }));

    expect(await screen.findByText('Copy failed')).toBeInTheDocument();
  });

  it('proposes a name from the browser and the person, and renames through the API', async () => {
    const user = userEvent.setup();
    const { calls } = show({ 'PATCH /device-tokens/t1': () => created({ name: 'Mac mini' }) });
    await mint(user);
    const name = await screen.findByLabelText(/token name/i);
    expect(name).toHaveValue('Chrome · Alex');
    await user.clear(name);
    await user.type(name, 'Mac mini');
    await user.click(screen.getByRole('button', { name: /save name/i }));
    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === 'PATCH' && c.path === '/device-tokens/t1')).toBe(true),
    );
  });

  it('offers the download for the selected target only', async () => {
    const user = userEvent.setup();
    show();
    await mint(user);
    const link = await screen.findByRole('link', { name: /download/i });
    expect(link).toHaveAttribute('href', '/api/v1/artifacts/extension/chrome');
    expect(link).toHaveTextContent('opportun-chrome-0.1.0.zip');
  });

  it('switches target before minting, and the download follows', async () => {
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('tab', { name: /firefox/i }));
    await mint(user);
    expect(await screen.findByRole('link', { name: /download/i })).toHaveAttribute(
      'href',
      '/api/v1/artifacts/extension/firefox',
    );
  });

  it('completes when this token checks in, not when any token does', async () => {
    const user = userEvent.setup();
    let polls = 0;
    show({
      'GET /device-tokens': () => {
        polls += 1;
        // Another token checking in must not finish this dialog.
        if (polls < 3) return { items: [created({ id: 'other', lastUsedAt: Date.now() })] };
        return { items: [created({ id: 't1', lastUsedAt: Date.now() })] };
      },
    });
    await mint(user);
    expect(await screen.findByText(/waiting for the extension/i)).toBeInTheDocument();
    expect(await screen.findByText(/connected/i, {}, { timeout: 4000 })).toBeInTheDocument();
  });

  it('shows the address the download will point the extension at (design D21)', async () => {
    const user = userEvent.setup();
    show();
    await mint(user);
    // A wrong address has to be visible here: inside the extension popup the user cannot be
    // carrying a second value, so a mismatch found there costs them the token.
    expect(await screen.findByText(/http:\/\/nas\.local:8080/)).toBeInTheDocument();
  });

  it('#118: shows the build stamp next to the download, so it can be checked against an installed copy', async () => {
    const user = userEvent.setup();
    show();
    await mint(user);
    expect(
      await screen.findByText('0.1.0+abc12345 (d4c5383, 2026-10-21T05:19:32.775Z)'),
    ).toBeInTheDocument();
  });

  it('#118: says nothing about a build stamp this server does not have', async () => {
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('tab', { name: /firefox/i }));
    await mint(user);
    await screen.findByRole('link', { name: /download/i });
    expect(screen.queryByText(/this download is build/i)).not.toBeInTheDocument();
  });

  it('shows the build command instead of a download when nothing was built', async () => {
    const user = userEvent.setup();
    show({
      'GET /artifacts/extension': {
        ...TARGETS,
        targets: TARGETS.targets.map((t) => ({ ...t, available: false })),
      },
    });
    await mint(user);
    expect(await screen.findByText(/pnpm --filter @opportun\/extension build/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /download/i })).not.toBeInTheDocument();
  });

  it('does not offer a password field it cannot check', async () => {
    show({ 'GET /auth/2fa': () => ({ status: 500, body: { error: { code: 'server_error' } } }) });
    // Defaulting to "has a password" would end in "That is not your current password."
    expect(await screen.findByText(/could not check/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });

  it('surfaces a failed artifacts listing instead of rendering empty slots', async () => {
    show({
      'GET /artifacts/extension': () => ({
        status: 500,
        body: { error: { code: 'server_error' } },
      }),
    });
    expect(await screen.findByText(/could not load the downloads/i)).toBeInTheDocument();
  });

  it('stops asking once the extension has checked in', async () => {
    const user = userEvent.setup();
    let polls = 0;
    const { calls } = show({
      'GET /device-tokens': () => {
        polls += 1;
        return { items: [created({ id: 't1', lastUsedAt: Date.now() })] };
      },
    });
    await mint(user);
    await screen.findByText(/connected/i, {}, { timeout: 4000 });
    const settled = calls.filter((c) => c.path === '/device-tokens' && c.method === 'GET').length;
    await new Promise((r) => setTimeout(r, 120)); // many poll intervals at pollMs=10
    expect(
      calls.filter((c) => c.path === '/device-tokens' && c.method === 'GET').length,
    ).toBeLessThanOrEqual(settled + 1);
    expect(polls).toBeGreaterThan(0);
  });

  it('lets you change browser after minting, since the token is not target-specific', async () => {
    const user = userEvent.setup();
    show();
    await mint(user);
    await user.click(screen.getByRole('tab', { name: /firefox/i }));
    expect(await screen.findByRole('link', { name: /download/i })).toHaveAttribute(
      'href',
      '/api/v1/artifacts/extension/firefox',
    );
  });

  it('warns before closing while the token is still on screen', async () => {
    const user = userEvent.setup();
    let closed = false;
    show(
      {},
      {
        onOpenChange: (open: boolean) => {
          closed = !open;
        },
      },
    );
    await mint(user);
    await user.click(screen.getByRole('button', { name: 'Close setup' }));
    expect(await screen.findByText(/cannot be shown again/i)).toBeInTheDocument();
    expect(closed).toBe(false);
  });
});
