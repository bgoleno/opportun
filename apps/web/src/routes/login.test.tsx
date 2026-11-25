// The sign-in page says why a provider's sign-in brought the user back once, and goes on to the page that
// was asked for after a later one (https://github.com/bgoleno/opportun/issues/942). The app's own route
// tree, as it is loaded; what a page load would begin again is begun again here.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { meQuery, type User } from '@/lib/auth';
import { ThemeProvider } from '@/lib/theme';
import { routeTree } from '@/routeTree.gen';
import { mockApi } from '@/test/render';

const KEY = 'opportun.loginRedirect';
const USER: User = { id: 'u1', email: 'owner@example.com', displayName: 'Alex', isAdmin: false };
const CANCELLED = 'Sign-in was cancelled at the provider.';
const kept = () =>
  JSON.parse(window.sessionStorage.getItem(KEY) ?? 'null') as { to: string } | null;
const put = (to: unknown, at = Date.now()) =>
  window.sessionStorage.setItem(KEY, JSON.stringify({ to, at }));

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

const ROUTES = {
  'GET /auth/oauth/providers': { providers: ['github'] },
  'GET /auth/registration': { open: false },
  'POST /auth/login': { user: USER },
  'POST /auth/2fa/verify': { user: USER },
};

/** The app loaded at `path`, signed out unless told, in a history that can be loaded again. */
async function load(
  path: string | ReturnType<typeof createMemoryHistory>,
  opts: { user?: User; routes?: Record<string, unknown>; tree?: typeof routeTree } = {},
) {
  cleanup();
  mockApi({ ...ROUTES, ...opts.routes });
  const history = typeof path === 'string' ? createMemoryHistory({ initialEntries: [path] }) : path;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(meQuery.queryKey, opts.user ?? null);
  const router = createRouter({
    routeTree: opts.tree ?? routeTree,
    context: { queryClient },
    history,
  });
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

async function signIn({ user }: Loaded): Promise<void> {
  await user.type(await screen.findByLabelText('Email'), 'owner@example.com');
  await user.type(screen.getByLabelText('Password'), 'correct horse battery');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}
async function pressProvider({ user }: Loaded): Promise<void> {
  const link = await screen.findByRole('link', { name: 'Continue with GitHub' });
  // jsdom leaves no page: the press is all there is of it.
  link.addEventListener('click', (e) => e.preventDefault());
  await user.click(link);
}

describe('the reason', () => {
  it('is said, and taken out of the address alone, in place', async () => {
    const t = await load('/login?oauth=denied&x=1&redirect=%2Fpipeline%3Fstage%3Dapplied');
    expect(await screen.findByText(CANCELLED)).toBeInTheDocument();
    await waitFor(() => expect(at(t)).not.toContain('oauth'));
    expect(t.router.state.location.search).toEqual({ x: 1, redirect: '/pipeline?stage=applied' });
    expect(screen.getByText(CANCELLED)).toBeInTheDocument();
    expect(t.history.length).toBe(1);
  });

  it('is not said again on a reload', async () => {
    const t = await load('/login?oauth=denied');
    expect(await screen.findByText(CANCELLED)).toBeInTheDocument();
    await waitFor(() => expect(at(t)).toBe('/login'));
    await load(t.history);
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(screen.queryByText(CANCELLED)).toBeNull();
  });

  it('nor after going on from the page and back', async () => {
    const t = await load('/login?oauth=denied');
    await waitFor(() => expect(at(t)).toBe('/login'));
    await act(async () => void (await t.router.navigate({ to: '/register' })));
    await act(async () => t.history.back());
    await waitFor(() => expect(at(t)).toBe('/login'));
    expect(screen.queryByText(CANCELLED)).toBeNull();
  });

  it('goes when a provider is pressed: a page that a browser shows again on Back says nothing', async () => {
    const t = await load('/login?oauth=denied');
    expect(await screen.findByText(CANCELLED)).toBeInTheDocument();
    await pressProvider(t);
    expect(screen.queryByText(CANCELLED)).toBeNull();
  });

  it('is one of the list: no text of the address is shown', async () => {
    const t = await load('/login?oauth=Call%20555%200100');
    expect(await screen.findByText(/Something went wrong signing in/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('555');
    await waitFor(() => expect(at(t)).toBe('/login'));
  });

  it('control: without one the address stays as it is', async () => {
    const t = await load('/login?redirect=%2Finbox&x=1');
    await screen.findByLabelText('Email');
    expect(t.router.state.location.search).toEqual({ redirect: '/inbox', x: 1 });
  });
});

describe('the page that was asked for', () => {
  const ASKED = '/pipeline?stage=applied#notes';
  const ASKED_LOGIN = `/login?redirect=${encodeURIComponent(ASKED)}`;

  it('control: is gone to after a password', async () => {
    const t = await load(ASKED_LOGIN);
    await signIn(t);
    await waitFor(() => expect(at(t)).toBe(ASKED));
    expect(t.history.length).toBe(1);
  });

  it('survives a provider that failed, and is gone to after a password', async () => {
    await pressProvider(await load(ASKED_LOGIN));
    expect(kept()).toMatchObject({ to: ASKED });
    // As the server sends the browser back.
    const t = await load('/login?oauth=denied');
    await waitFor(() => expect(t.router.state.location.search).toEqual({ redirect: ASKED }));
    expect(screen.getByText(CANCELLED)).toBeInTheDocument();
    await signIn(t);
    await waitFor(() => expect(at(t)).toBe(ASKED));
    expect(kept()).toBeNull();
  });

  it('survives two, and a reload between them', async () => {
    await pressProvider(await load(ASKED_LOGIN));
    const first = await load('/login?oauth=denied');
    await waitFor(() => expect(first.router.state.location.search).toEqual({ redirect: ASKED }));
    const again = await load(first.history);
    window.sessionStorage.clear();
    await pressProvider(again);
    const second = await load('/login?oauth=unknown');
    await waitFor(() => expect(second.router.state.location.search).toEqual({ redirect: ASKED }));
    await signIn(second);
    await waitFor(() => expect(at(second)).toBe(ASKED));
  });

  it('survives a provider that asks for the second step, and is gone to after it', async () => {
    await pressProvider(await load(ASKED_LOGIN));
    window.history.replaceState(null, '', `/login#pending2fa=${'a'.repeat(32)}`);
    const t = await load('/login');
    await t.user.type(await screen.findByLabelText('Authentication code'), '123456');
    await t.user.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(at(t)).toBe(ASKED));
    expect(kept()).toBeNull();
  });

  it('a second step’s token, taken from the address, is not put back in it', async () => {
    put('/inbox');
    const token = 'b'.repeat(32);
    window.history.replaceState(null, '', `/login#pending2fa=${token}`);
    const t = await load(`/login?oauth=denied#pending2fa=${token}`);
    await screen.findByLabelText('Authentication code');
    await waitFor(() => expect(at(t)).toBe('/login?redirect=%2Finbox'));
  });

  it('of the address wins over what is kept', async () => {
    put('/inbox');
    const t = await load('/login?oauth=denied&redirect=%2Fpipeline');
    await waitFor(() => expect(t.router.state.location.search).toEqual({ redirect: '/pipeline' }));
    await signIn(t);
    await waitFor(() => expect(at(t)).toBe('/pipeline'));
  });

  it('is not what an earlier try kept, when this one asked for none', async () => {
    put('/inbox');
    const t = await load('/login?redirect=%2F%2Fevil.example');
    await pressProvider(t);
    expect(kept()).toBeNull();
  });

  it.each(['https://evil.example/x', '//evil.example', '/%2F/evil.example', '/api/v1/x', '/LOGIN'])(
    'elsewhere (%s) is not kept, put back, or gone to',
    async (elsewhere) => {
      const t = await load(`/login?redirect=${encodeURIComponent(elsewhere)}`);
      await pressProvider(t);
      expect(kept()).toBeNull();
      put(elsewhere);
      const back = await load('/login?oauth=denied');
      await waitFor(() => expect(at(back)).toBe('/login'));
      expect(kept()).toBeNull();
      await signIn(back);
      await waitFor(() => expect(at(back)).toBe('/'));
      const asked = await load(`/login?redirect=${encodeURIComponent(elsewhere)}`);
      await signIn(asked);
      await waitFor(() => expect(at(asked)).toBe('/'));
    },
  );

  it.each(['not JSON', 'null', '7', '{"to":'])('%s in its place is removed', async (text) => {
    window.sessionStorage.setItem(KEY, text);
    const t = await load('/login?oauth=denied');
    await waitFor(() => expect(at(t)).toBe('/login'));
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it('an old one is not put back', async () => {
    put('/inbox', Date.now() - 11 * 60 * 1000);
    const t = await load('/login?oauth=denied');
    await waitFor(() => expect(at(t)).toBe('/login'));
    expect(kept()).toBeNull();
  });
});

// The first load of the app is told by its own modules, loaded anew.
describe('a provider’s success, which lands on /', () => {
  async function fresh() {
    vi.resetModules();
    const { routeTree: tree } = await import('@/routeTree.gen');
    return tree;
  }

  it('goes on to the page that was asked for, in place of /, and once', async () => {
    put('/pipeline?stage=applied#notes');
    const tree = await fresh();
    const t = await load('/', { user: USER, tree });
    await waitFor(() => expect(at(t)).toBe('/pipeline?stage=applied#notes'));
    expect(t.history.length).toBe(1);
    expect(kept()).toBeNull();
    // Dashboard, pressed later, is the Dashboard, whatever another try has kept since.
    put('/inbox');
    await act(async () => void (await t.router.navigate({ to: '/' })));
    expect(at(t)).toBe('/');
  }, 30_000);

  it('a preload does not take it', async () => {
    put('/pipeline');
    const tree = await fresh();
    const queryClient = new QueryClient();
    queryClient.setQueryData(meQuery.queryKey, USER);
    mockApi(ROUTES);
    const router = createRouter({
      routeTree: tree,
      context: { queryClient },
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    await router.preloadRoute({ to: '/' });
    expect(kept()).not.toBeNull();
    await router.load();
    expect(router.state.location.href).toBe('/pipeline');
  }, 30_000);
});
