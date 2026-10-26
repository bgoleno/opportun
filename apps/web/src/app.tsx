// Loaded by main.tsx only after the zod config has run (see there).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from './components/ui/toast';
import { setUnauthorizedHandler } from './lib/api';
import { meQuery } from './lib/auth';
import { ThemeProvider } from './lib/theme';
import { routeTree } from './routeTree.gen';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
  },
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// Session expired mid-use: forget cached data and go to the sign-in screen.
setUnauthorizedHandler(() => {
  const here = router.state.location;
  if (here.pathname === '/login' || here.pathname === '/register') return;
  queryClient.clear();
  queryClient.setQueryData(meQuery.queryKey, null);
  void router.navigate({ to: '/login', search: { redirect: here.href } });
});

const rootEl = document.getElementById('root');
if (rootEl === null) throw new Error('missing #root');

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <RouterProvider router={router} />
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
