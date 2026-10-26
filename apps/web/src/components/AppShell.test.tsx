import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '@/components/AppShell';
import { meQuery, type User } from '@/lib/auth';
import { SIDEBAR_STORAGE_KEY } from '@/lib/sidebar';
import { ThemeProvider } from '@/lib/theme';
import { mockApi, renderWithProviders } from '@/test/render';

const user: User = {
  id: 'u1',
  email: 'owner@example.com',
  displayName: 'Alex Rivera',
  isAdmin: false,
};

/**
 * A controllable viewport-height media query. jsdom has no matchMedia, and the sidebar
 * asks whether the window is short (a phone held in landscape) to pick its default.
 */
function mockShortViewport(short: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('max-height') ? short : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    })),
  );
}

/** The memory router mounts asynchronously, so wait for the shell before asserting. */
async function renderShell(path?: string) {
  mockApi({ 'GET /settings/theme': { theme: 'auto' } });
  const result = renderWithProviders(
    <ThemeProvider>
      <AppShell user={user}>
        <p>Inbox contents</p>
      </AppShell>
    </ThemeProvider>,
    { path },
  );
  await screen.findByRole('navigation', { name: 'Main' });
  return result;
}

const sidebar = () => screen.getByRole('navigation', { name: 'Main' });
const toggle = () => screen.getByRole('button', { name: /sidebar/i });

beforeEach(() => {
  mockShortViewport(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AppShell sidebar collapse', () => {
  it('starts expanded on a tall window', async () => {
    await renderShell();
    expect(sidebar()).toHaveAttribute('data-collapsed', 'false');
    expect(toggle()).toHaveAccessibleName('Collapse sidebar');
  });

  it('collapses the sidebar when the toggle is pressed', async () => {
    await renderShell();

    await userEvent.click(toggle());

    expect(sidebar()).toHaveAttribute('data-collapsed', 'true');
    expect(toggle()).toHaveAccessibleName('Expand sidebar');
  });

  it('expands again when the toggle is pressed a second time', async () => {
    await renderShell();

    await userEvent.click(toggle());
    await userEvent.click(toggle());

    expect(sidebar()).toHaveAttribute('data-collapsed', 'false');
  });

  it('keeps every destination reachable by name while collapsed', async () => {
    await renderShell();

    await userEvent.click(toggle());

    expect(screen.getByRole('link', { name: 'Inbox' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pipeline' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
  });

  it('remembers the collapsed choice for the next visit', async () => {
    const first = await renderShell();

    await userEvent.click(toggle());
    await waitFor(() => {
      expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('collapsed');
    });

    first.unmount();
    await renderShell();

    expect(sidebar()).toHaveAttribute('data-collapsed', 'true');
  });

  it('starts collapsed on a short window, as when a phone is held in landscape', async () => {
    mockShortViewport(true);

    await renderShell();

    expect(sidebar()).toHaveAttribute('data-collapsed', 'true');
  });

  it('lets a stored choice win over the short-window default', async () => {
    mockShortViewport(true);
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, 'expanded');

    await renderShell();

    expect(sidebar()).toHaveAttribute('data-collapsed', 'false');
  });

  it('#138: the toggle itself shows a tooltip on hover, matching its aria-label', async () => {
    await renderShell();
    await userEvent.hover(toggle());
    expect(await screen.findByText('Collapse sidebar')).toBeInTheDocument();
  });

  it('#138: a collapsed destination shows a tooltip on hover, since its label is sr-only there', async () => {
    await renderShell();
    await userEvent.click(toggle());

    const inbox = screen.getByRole('link', { name: 'Inbox' });
    expect(
      screen.queryByText('Inbox', { selector: '[data-slot="tooltip-content"]' }),
    ).not.toBeInTheDocument();
    await userEvent.hover(inbox);
    expect(
      await screen.findByText('Inbox', { selector: '[data-slot="tooltip-content"]' }),
    ).toBeInTheDocument();
  });

  it('#138: an expanded destination has no tooltip, since its label is already visible', async () => {
    await renderShell();
    await userEvent.hover(screen.getByRole('link', { name: 'Inbox' }));
    expect(
      screen.queryByText('Inbox', { selector: '[data-slot="tooltip-content"]' }),
    ).not.toBeInTheDocument();
  });
});

/**
 * Below md the sidebar is hidden entirely and the destinations move into a menu behind a
 * three-bar button, so a portrait phone does not get a nav strip it has to scroll.
 */
describe('AppShell mobile navigation menu', () => {
  const menuButton = () => screen.getByRole('button', { name: 'Open navigation menu' });

  it('offers a menu button', async () => {
    await renderShell();
    expect(menuButton()).toBeInTheDocument();
  });

  it('#138: shows a tooltip on hover without the hover breaking the menu itself', async () => {
    await renderShell();
    await userEvent.hover(menuButton());
    expect(await screen.findByText('Open navigation menu')).toBeInTheDocument();
    await userEvent.click(menuButton());
    expect(await screen.findByRole('menu')).toBeInTheDocument();
  });

  it('lists every destination once opened', async () => {
    await renderShell();

    await userEvent.click(menuButton());

    const menu = await screen.findByRole('menu');
    const names = within(menu)
      .getAllByRole('menuitem')
      .map((el) => el.textContent);
    expect(names).toEqual([
      'Dashboard',
      'Pipeline',
      'Discovery',
      'Resumes',
      'Inbox',
      'Contacts',
      'Settings',
    ]);
  });

  it('marks the destination you are already on', async () => {
    await renderShell('/pipeline');

    await userEvent.click(menuButton());

    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Pipeline' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(menu).getByRole('menuitem', { name: 'Inbox' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('navigates when a destination is chosen', async () => {
    const { router } = await renderShell();

    await userEvent.click(menuButton());
    const menu = await screen.findByRole('menu');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Contacts' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/contacts');
    });
  });
});

/**
 * Issue #151: showing signed-out for a logout that did not happen leaves a live server
 * session behind a screen that just told someone it was safe to walk away. These cover both
 * sides the fix has to hold at once: never show signed-out before the server confirms it, and
 * still offer a way out that is honest about what it did and did not do server-side.
 */
describe('AppShell account menu sign-out (issue #151)', () => {
  const accountMenuButton = () => screen.getByRole('button', { name: /^Account:/ });

  async function openSignOut() {
    await userEvent.click(accountMenuButton());
    const menu = await screen.findByRole('menu');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Sign out' }));
  }

  it('clears the session and leaves once the server confirms it', async () => {
    const { router, queryClient } = await renderShell();
    queryClient.setQueryData(meQuery.queryKey, user);
    mockApi({ 'POST /auth/logout': { status: 204, body: null } });

    await openSignOut();

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(queryClient.getQueryData(meQuery.queryKey)).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stays signed in and says so, rather than leaving for a logout the server never confirmed', async () => {
    const { router, queryClient } = await renderShell();
    queryClient.setQueryData(meQuery.queryKey, user);
    mockApi({
      'POST /auth/logout': () => ({ status: 500, body: { error: { code: 'server_error' } } }),
    });

    await openSignOut();

    const dialog = await screen.findByRole('dialog', { name: 'Could not confirm sign-out' });
    expect(dialog).toHaveTextContent(/still signed in on this device/i);
    // The point of the fix: the cache still says signed in, and the route never changed.
    expect(queryClient.getQueryData(meQuery.queryKey)).toEqual(user);
    expect(router.state.location.pathname).not.toBe('/login');
  });

  it('cancelling the dialog leaves the session exactly as it was, so a retry is still possible', async () => {
    const { router, queryClient } = await renderShell();
    queryClient.setQueryData(meQuery.queryKey, user);
    mockApi({
      'POST /auth/logout': () => ({ status: 500, body: { error: { code: 'server_error' } } }),
    });

    await openSignOut();
    await screen.findByRole('dialog', { name: 'Could not confirm sign-out' });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(queryClient.getQueryData(meQuery.queryKey)).toEqual(user);
    expect(router.state.location.pathname).not.toBe('/login');
    // Still reachable from the account menu, exactly as before the failed attempt.
    expect(accountMenuButton()).toBeInTheDocument();
  });

  it("leaving anyway clears this browser's own belief it is signed in, without claiming the server confirmed anything", async () => {
    const { router, queryClient } = await renderShell();
    queryClient.setQueryData(meQuery.queryKey, user);
    mockApi({
      'POST /auth/logout': () => ({ status: 500, body: { error: { code: 'server_error' } } }),
    });

    await openSignOut();
    const dialog = await screen.findByRole('dialog', { name: 'Could not confirm sign-out' });
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Sign out of this browser anyway' }),
    );

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(queryClient.getQueryData(meQuery.queryKey)).toBeNull();
  });
});
