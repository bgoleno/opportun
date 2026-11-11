// The metrics page's list filters and chosen metric come from the URL (FR-T6,
// https://github.com/bgoleno/opportun/issues/346). These load the real route tree. The router
// hands a route its own validated search merged over the raw search its parent routes pass
// through, so a value parseMetricsSearch dropped can still be in Route.useSearch(); the page
// must only ever see what the parser kept (as qa found on the traces page,
// https://github.com/bgoleno/opportun/pull/361).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { meQuery, type User } from '@/lib/auth';
import { ThemeProvider } from '@/lib/theme';
import { routeTree } from '@/routeTree.gen';
import { mockApi } from '@/test/render';

const user: User = { id: 'u1', email: 'owner@example.com', displayName: 'Alex', isAdmin: true };

describe('/settings/metrics search', () => {
  it('shows only the search values the route keeps', async () => {
    mockApi({
      'GET /obs/metrics': {
        collect: true,
        metrics: [
          {
            name: 'opportun.job.duration',
            instrument: 'histogram',
            unit: 's',
            description: 'Duration of background jobs, from claim to finish.',
            scope: 'instance',
            attributes: ['opportun.job.kind'],
            stats: ['count'],
          },
        ],
      },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(meQuery.queryKey, user);
    // A search text past the 100 characters the route keeps.
    const long = 'x'.repeat(150);
    const history = createMemoryHistory({ initialEntries: [`/settings/metrics?q=${long}`] });
    const router = createRouter({ routeTree, context: { queryClient }, history });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    const box = await screen.findByLabelText('Search metrics');
    expect(box).toHaveValue('');
    expect(await screen.findByRole('list', { name: 'Metrics' })).toBeInTheDocument();
  });
});
