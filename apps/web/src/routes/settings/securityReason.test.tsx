// Settings > Security says why a provider's round trip brought the user back once: a reload, Back or a
// second visit has nothing to say, and the rest of the address stays
// (https://github.com/bgoleno/opportun/issues/1021). The app's own route tree, as a page load loads it.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { meQuery, type User } from '@/lib/auth';
import { ThemeProvider } from '@/lib/theme';
import { routeTree } from '@/routeTree.gen';
import { mockApi } from '@/test/render';

const USER: User = { id: 'u1', email: 'owner@example.com', displayName: 'Alex', isAdmin: false };
const PAGE = '/settings/security';

/** Each reason the page can be given, and what it says. The last three are an account's with no password. */
const REASONS: [string, RegExp, boolean][] = [
  ['linked', /^Account linked\. You can now sign in with it\.$/, true],
  ['conflict', /^That provider account could not be linked/, true],
  ['denied', /^Linking was cancelled at the provider\.$/, true],
  ['error', /^Something went wrong linking that account/, true],
  ['not_completed', /^That link was not completed/, true],
  ['setpw_mismatch', /^That provider account is not the one linked/, false],
  ['setpw_denied', /^The confirmation was cancelled at the provider\.$/, false],
  ['setpw_error', /^Something went wrong confirming with the provider/, false],
];

async function load(
  path: string | ReturnType<typeof createMemoryHistory>,
  opts: { hasPassword?: boolean; routes?: Record<string, unknown> } = {},
) {
  cleanup();
  const hasPassword = opts.hasPassword ?? true;
  mockApi({
    'GET /auth/oauth/providers': { providers: ['github'] },
    'GET /auth/oauth/accounts': {
      hasPassword,
      accounts: [{ provider: 'github', createdAt: 1 }],
    },
    'GET /auth/2fa': { enabled: false, recoveryCodesLeft: 0, hasPassword },
    ...opts.routes,
  });
  const history = typeof path === 'string' ? createMemoryHistory({ initialEntries: [path] }) : path;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(meQuery.queryKey, USER);
  const router = createRouter({ routeTree, context: { queryClient }, history });
  await act(async () => {
    render(
      <StrictMode>
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </ThemeProvider>
      </StrictMode>,
    );
  });
  return { router, history, user: userEvent.setup() };
}
type Loaded = Awaited<ReturnType<typeof load>>;
const at = ({ router }: Loaded) => router.state.location.href;
const shown = () => screen.findByText('Linked accounts');

describe.each(REASONS)('%s', (reason, words, hasPassword) => {
  it('is said, and taken out of the address alone, in place', async () => {
    const t = await load(`${PAGE}?oauth=${reason}&x=1#linked`, { hasPassword });
    expect(await screen.findByText(words)).toBeInTheDocument();
    await waitFor(() => expect(at(t)).toBe(`${PAGE}?x=1#linked`));
    expect(t.history.length).toBe(1);
    expect(screen.getByText(words)).toBeInTheDocument();
  });

  it('is not said again on a reload', async () => {
    const t = await load(`${PAGE}?oauth=${reason}`, { hasPassword });
    expect(await screen.findByText(words)).toBeInTheDocument();
    await waitFor(() => expect(at(t)).toBe(PAGE));
    await load(t.history, { hasPassword });
    await shown();
    expect(screen.queryByText(words)).toBeNull();
  });

  it('nor on Back, nor on a second visit', async () => {
    const t = await load(`${PAGE}?oauth=${reason}`, { hasPassword });
    await waitFor(() => expect(at(t)).toBe(PAGE));
    await act(async () => void (await t.router.navigate({ to: '/settings/account' })));
    expect(screen.queryByText(words)).toBeNull();
    await act(async () => t.history.back());
    await waitFor(() => expect(at(t)).toBe(PAGE));
    await shown();
    expect(screen.queryByText(words)).toBeNull();
    await act(async () => void (await t.router.navigate({ to: '/settings/account' })));
    await act(async () => void (await t.router.navigate({ to: PAGE })));
    await shown();
    expect(screen.queryByText(words)).toBeNull();
  });
});

it('control: without a reason the address stays as it is', async () => {
  const history = createMemoryHistory({ initialEntries: [`${PAGE}?x=1#linked`] });
  const replace = vi.spyOn(history, 'replace');
  const t = await load(history);
  await shown();
  expect(at(t)).toBe(`${PAGE}?x=1#linked`);
  expect(replace).not.toHaveBeenCalled();
});

it('a reason that is none of them says nothing, and goes too', async () => {
  const t = await load(`${PAGE}?oauth=Call%20555%200100`);
  await shown();
  await waitFor(() => expect(at(t)).toBe(PAGE));
  expect(document.body.textContent).not.toContain('555');
});

// Not a reason but a step that is open for five minutes: a reload must not ask for the provider again.
describe('a confirmation that is good for a password', () => {
  const READY = `${PAGE}?oauth=setpw_ready&x=1`;
  // The card of an account with a password, shown until that is known, has a field of the same name.
  const fields = async () => {
    await screen.findByRole('button', { name: 'Set password' });
    return screen.getByLabelText('New password');
  };
  async function setPassword(t: Loaded): Promise<void> {
    await t.user.type(await fields(), 'correct horse battery');
    await t.user.type(screen.getByLabelText('Confirm new password'), 'correct horse battery');
    await t.user.click(screen.getByRole('button', { name: 'Set password' }));
  }

  it('stays over a reload until it is used', async () => {
    const t = await load(READY, { hasPassword: false });
    await fields();
    await load(t.history, { hasPassword: false });
    await fields();
    expect(at(t)).toBe(READY);
  });

  it('is gone once the password is set', async () => {
    const t = await load(READY, {
      hasPassword: false,
      routes: { 'POST /auth/password': { status: 204 } },
    });
    await setPassword(t);
    await waitFor(() => expect(at(t)).toBe(`${PAGE}?x=1`));
  });

  it('and once it has run out', async () => {
    const t = await load(READY, {
      hasPassword: false,
      routes: {
        'POST /auth/password': { status: 403, body: { error: { code: 'reauth_required' } } },
      },
    });
    await setPassword(t);
    expect(await screen.findByText(/^That confirmation expired/)).toBeInTheDocument();
    await waitFor(() => expect(at(t)).toBe(`${PAGE}?x=1`));
    await load(t.history, { hasPassword: false });
    expect(await screen.findByRole('button', { name: 'Confirm with GitHub' })).toBeInTheDocument();
    expect(screen.queryByLabelText('New password')).toBeNull();
  });
});
