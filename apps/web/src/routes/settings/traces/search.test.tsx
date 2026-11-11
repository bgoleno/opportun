// The traces page's filters come from the URL (FR-T7, https://github.com/bgoleno/opportun/issues/347).
// These load the real route tree. A value of the wrong shape must never be sent to the server
// (qa on https://github.com/bgoleno/opportun/pull/361): the router hands a route the search its
// parents passed through as well as what its own validateSearch returned, so a key the page's
// parser dropped can still be in Route.useSearch().
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { meQuery, type User } from '@/lib/auth';
import { ThemeProvider } from '@/lib/theme';
import { routeTree } from '@/routeTree.gen';
import { mockApi } from '@/test/render';

const user: User = { id: 'u1', email: 'owner@example.com', displayName: 'Alex', isAdmin: false };

/** Opens the traces page at `path` on the real route tree; returns what the list request sent. */
async function sentFor(path: string): Promise<URLSearchParams> {
  const { calls } = mockApi({
    'GET /obs/traces': { collect: true, items: [], next: null },
    'GET /obs/traces/filters': { tasks: [], models: [], providers: [] },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(meQuery.queryKey, user);
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({ routeTree, context: { queryClient }, history });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <RouterProvider router={router} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(calls.some((c) => c.path === '/obs/traces')).toBe(true));
  return new URLSearchParams(calls.find((c) => c.path === '/obs/traces')!.search);
}

describe('/settings/traces search', () => {
  it('sends only the filters of the right shape', async () => {
    const sent = await sentFor('/settings/traces?status=failed&task=resume.tailor&range=2d');
    expect([...sent.keys()]).toEqual(['task']);
    expect(sent.get('task')).toBe('resume.tailor');
  });

  // The server's shapes (routes/obsTraces.ts): a value of any other shape is refused there with
  // its validation text, so the page drops it and shows its unfiltered state instead
  // (https://github.com/bgoleno/opportun/issues/365).
  it.each([
    ['task', 'Bad Task', 'Task'],
    ['task', 'resume.tailor; drop', 'Task'],
    ['model', 'a/b/c', 'Model'],
    ['model', '/etc/passwd', 'Model'],
    ['provider', 'Open-AI', 'Provider'],
    ['conversation', 'not a row id!', null],
  ])('drops %s=%j and shows the unfiltered list', async (key, value, label) => {
    const sent = await sentFor(`/settings/traces?status=ok&${key}=${encodeURIComponent(value)}`);
    expect([...sent.keys()]).toEqual(['status']);
    if (label !== null) expect(await screen.findByLabelText(label)).toHaveValue('');
    expect(screen.queryByText(/Invalid|expected/)).toBeNull();
  });

  it('keeps a model id with one slash and a colon', async () => {
    const sent = await sentFor('/settings/traces?model=us.anthropic%2Fclaude-opus-5-5%3A0');
    expect(sent.get('model')).toBe('us.anthropic/claude-opus-5-5:0');
  });
});
