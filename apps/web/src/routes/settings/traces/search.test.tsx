// The traces page's filters come from the URL (FR-T7, https://github.com/bgoleno/opportun/issues/347).
// These load the real route tree. A value of the wrong shape must never be sent to the server
// (qa on https://github.com/bgoleno/opportun/pull/361): the router hands a route the search its
// parents passed through as well as what its own validateSearch returned, so a key the page's
// parser dropped can still be in Route.useSearch().
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { meQuery, type User } from '@/lib/auth';
import { ThemeProvider } from '@/lib/theme';
import { routeTree } from '@/routeTree.gen';
import { mockApi } from '@/test/render';

const user: User = { id: 'u1', email: 'owner@example.com', displayName: 'Alex', isAdmin: false };

describe('/settings/traces search', () => {
  it('sends only the filters of the right shape', async () => {
    const { calls } = mockApi({
      'GET /obs/traces': { collect: true, items: [], next: null },
      'GET /obs/traces/filters': { tasks: [], models: [], providers: [] },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(meQuery.queryKey, user);
    const history = createMemoryHistory({
      initialEntries: ['/settings/traces?status=failed&task=resume.tailor&range=2d'],
    });
    const router = createRouter({ routeTree, context: { queryClient }, history });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(calls.some((c) => c.path === '/obs/traces')).toBe(true));
    const sent = new URLSearchParams(calls.find((c) => c.path === '/obs/traces')!.search);
    expect([...sent.keys()]).toEqual(['task']);
    expect(sent.get('task')).toBe('resume.tailor');
  });
});
