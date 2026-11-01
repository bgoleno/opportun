// Layout widths (issue https://github.com/bgoleno/opportun/issues/32, docs/design.md section 9):
// every view is page width unless its route declares fluid, and the set of fluid routes is
// pinned here, so making a view fluid changes this test and is a visible decision in review.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppShell } from '@/components/AppShell';
import type { User } from '@/lib/auth';
import { ThemeProvider } from '@/lib/theme';
import { routeTree } from '@/routeTree.gen';
import { mockApi } from '@/test/render';

describe('fluid routes', () => {
  it('are exactly the boards and lists docs/design.md section 9 names', () => {
    const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });
    const fluid = Object.values(router.routesById)
      .filter((r) => r.options.staticData?.layout === 'fluid')
      .map((r) => r.id as string)
      .sort();
    expect(fluid).toEqual([
      '/contacts/',
      '/discovery/',
      '/discovery/decided',
      '/inbox',
      '/pipeline',
    ]);
  });
});

const user: User = { id: 'u1', email: 'owner@example.com', displayName: 'Alex', isAdmin: false };

/** AppShell around a small route tree: plain, fluid, and a layout route with one fluid tab. */
async function contentBoxAt(path: string) {
  mockApi({ 'GET /settings/theme': { theme: 'auto' } });
  const root = createRootRoute({
    component: () => (
      <ThemeProvider>
        <AppShell user={user}>
          <Outlet />
        </AppShell>
      </ThemeProvider>
    ),
  });
  const page = (text: string) => () => <p>{text}</p>;
  const tabs = createRoute({ getParentRoute: () => root, path: '/tabs', component: Outlet });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: '/plain', component: page('Plain') }),
      createRoute({
        getParentRoute: () => root,
        path: '/wide',
        staticData: { layout: 'fluid' },
        component: page('Wide'),
      }),
      tabs.addChildren([
        createRoute({
          getParentRoute: () => tabs,
          path: '/',
          staticData: { layout: 'fluid' },
          component: page('Board tab'),
        }),
        createRoute({ getParentRoute: () => tabs, path: '/settings', component: page('Form tab') }),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const main = await screen.findByRole('main');
  const box = main.querySelector('[data-layout]');
  expect(box, 'the content box').not.toBeNull();
  return box as HTMLElement;
}

describe('AppShell content box', () => {
  it('caps a route that declares nothing at the page width, centred in the main area', async () => {
    const box = await contentBoxAt('/plain');
    expect(box).toHaveAttribute('data-layout', 'page');
    expect(box).toHaveClass('max-w-page', 'mx-auto', 'w-full');
    expect(box).toHaveTextContent('Plain');
  });

  it('lets a fluid route fill the main area', async () => {
    const box = await contentBoxAt('/wide');
    expect(box).toHaveAttribute('data-layout', 'fluid');
    expect(box).not.toHaveClass('max-w-page');
    expect(box).toHaveClass('w-full');
  });

  it('goes by the deepest route, so one tab of a layout route can be fluid alone', async () => {
    expect(await contentBoxAt('/tabs')).toHaveAttribute('data-layout', 'fluid');
  });

  it('keeps the other tabs of that layout route at page width', async () => {
    expect(await contentBoxAt('/tabs/settings')).toHaveAttribute('data-layout', 'page');
  });
});
