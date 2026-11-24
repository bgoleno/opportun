// Test helpers: render a component inside a QueryClient and a memory router, and stub
// fetch with a small route table that records every call.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { Toaster } from '@/components/ui/toast';
import { mockProblem } from './mockProblems';

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

/**
 * Queries inside the toast viewport, for a toast's own text. Radix Toast also copies each new
 * toast's title and description into a visually hidden live region outside the viewport, a frame
 * after the toast shows and for about a second, so a query on the whole screen can find a toast's
 * text twice or once depending on timing (https://github.com/bgoleno/opportun/issues/816).
 */
export function toastRegion() {
  return within(screen.getByRole('region', { name: /^Notifications/ }));
}

export interface ApiCall {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

type Handler = (call: ApiCall) => unknown;

interface Answer {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}
const ANSWER_KEYS = new Set(['status', 'body', 'headers']);

/**
 * What a route answers: `{status, body?, headers?}` when `status` is a number, else a 200 with the
 * value as its body (which can have a `status` of its own, 'denied' say). Two things no server of ours
 * answers fail the test (#941): an error's body with a status that isn't an error's, as a refusal
 * without its status is, and a numeric status among a body's own fields.
 */
function answerOf(route: string, value: unknown): Answer {
  let answer: Answer = { status: 200, body: value };
  if (typeof value === 'object' && value !== null && 'status' in value) {
    if (typeof value.status === 'number') {
      const fields = Object.keys(value).filter((k) => !ANSWER_KEYS.has(k));
      if (fields.length > 0) {
        mockProblem(`${route} has a numeric status beside ${fields.join(', ')}: put them in body`);
      }
      answer = value as Answer;
    }
  }
  const error = (answer.body as { error?: unknown } | null | undefined)?.error;
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string' && answer.status < 400) {
    mockProblem(`${route} answers the error ${code} with ${answer.status}`);
  }
  return answer;
}

/**
 * Stubs fetch. `routes` maps "METHOD /path" (path relative to /api/v1, no query) to what it answers,
 * or to a handler returning (or resolving to) that: {status, body} or a body (answerOf). Unmatched
 * calls answer 404.
 */
export function mockApi(routeTable: Record<string, unknown>) {
  const routes = new Map(Object.entries(routeTable));
  // The plain ones at once, so one that is never called is refused too.
  for (const [key, route] of routes) if (typeof route !== 'function') answerOf(key, route);
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
    const out = typeof route === 'function' ? await (route as Handler)(call) : route;
    const { status, body: payload, headers = {} } = answerOf(key, out);
    if (status === 204) return new Response(null, { status, headers });
    return new Response(payload === undefined ? '' : JSON.stringify(payload), { status, headers });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}
