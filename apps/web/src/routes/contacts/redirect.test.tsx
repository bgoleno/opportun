// The /contacts routes are aliases kept for bookmarks made before the section was renamed
// Network (issue https://github.com/bgoleno/opportun/issues/22). These load the real route
// tree, so they exercise the route files the app ships, not a copy of them.
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, createRouter } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { meQuery, type User } from '@/lib/auth';
import { routeTree } from '@/routeTree.gen';

const user: User = { id: 'u1', email: 'owner@example.com', displayName: 'Alex', isAdmin: false };

/** Resolves `path` as a signed-in user would land on it, following any redirect. */
async function land(path: string) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(meQuery.queryKey, user);
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({ routeTree, context: { queryClient }, history });
  await router.load();
  return { location: router.state.location };
}

describe('/contacts aliases', () => {
  it('/contacts/:id redirects to /network/:id', async () => {
    const { location } = await land('/contacts/c-1');
    expect(location.pathname).toBe('/network/c-1');
  });

  it('/contacts redirects to /network', async () => {
    const { location } = await land('/contacts');
    expect(location.pathname).toBe('/network');
  });

  it('keeps an id that needed encoding intact', async () => {
    const via = await land('/contacts/a%20b');
    const direct = await land('/network/a%20b');
    expect(via.location.href).toBe(direct.location.href);
  });
});
