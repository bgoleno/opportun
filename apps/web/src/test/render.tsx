// Test helpers: render a component inside a QueryClient and a memory router, and stub
// fetch with a small route table that records every call.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { Toaster } from '@/components/ui/toast';

export function renderWithProviders(ui: ReactNode, opts: { path?: string } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  // The root route renders the component at every path, so links can be followed and the
  // resulting location asserted on router.state.
  const rootRoute = createRootRoute({ component: () => <>{ui}</> });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [opts.path ?? '/'] }),
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>,
  );
  return { ...result, queryClient, router };
}

export interface ApiCall {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

type Handler = (call: ApiCall) => unknown;

/**
 * Stubs fetch. `routes` maps "METHOD /path" (path relative to /api/v1, no query) to a
 * response body, or to a handler returning (or resolving to) {status, body} or a body.
 * Unmatched calls answer 404.
 */
export function mockApi(routeTable: Record<string, unknown>) {
  const routes = new Map(Object.entries(routeTable));
  const calls: ApiCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    const call: ApiCall = { method, path, search: url.search, body };
    calls.push(call);
    const key = `${method} ${path}`;
    if (!routes.has(key)) {
      return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
    }
    const route = routes.get(key);
    let status = 200;
    let payload: unknown = route;
    if (typeof route === 'function') {
      const out = await (route as Handler)(call);
      if (typeof out === 'object' && out !== null && 'status' in out) {
        status = (out as { status: number }).status;
        payload = (out as { body?: unknown }).body;
      } else {
        payload = out;
      }
    }
    if (status === 204) return new Response(null, { status });
    return new Response(payload === undefined ? '' : JSON.stringify(payload), { status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}
