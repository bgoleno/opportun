// The AI trace dashboard (FR-T7, https://github.com/bgoleno/opportun/issues/347): the list, its
// filters and conversation groups, the empty state while collection is off, and one trace's
// waterfall with its span details and links.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactElement, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import type { SpanView, TraceFilters, TraceView } from './api';
import { TraceDetailPage } from './TraceDetail';
import { TracesPage } from './TracesPage';

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);

afterEach(() => {
  vi.restoreAllMocks();
});

const trace = (over: Partial<TraceView> = {}): TraceView => ({
  traceId: '0af7651916cd43dd8448eb211c80319c',
  startedAt: T0,
  durationMs: 1234,
  origin: 'POST /api/v1/opportunities/:id/match',
  workflow: null,
  feature: 'resumes',
  conversationId: null,
  tasks: ['resume.match'],
  models: ['claude-opus-5-5'],
  providers: ['anthropic'],
  inputTokens: 1200,
  outputTokens: 340,
  estCostUsd: 0.0123,
  spanCount: 2,
  errorCount: 0,
  status: 'ok',
  truncated: false,
  ...over,
});

const FILTER_VALUES = {
  tasks: ['resume.match', 'resume.tailor'],
  models: ['claude-opus-5-5', 'gpt-5'],
  providers: ['anthropic', 'openai'],
};

/** The page with its filters held in state, as the route holds them in the URL. */
function Harness({ isAdmin = false, initial = {} }: { isAdmin?: boolean; initial?: TraceFilters }) {
  const [filters, setFilters] = useState<TraceFilters>(initial);
  return <TracesPage isAdmin={isAdmin} filters={filters} onFiltersChange={setFilters} />;
}

describe('TracesPage', () => {
  it('lists each trace with its time, task, model, duration, tokens, cost and status', async () => {
    mockApi({
      'GET /obs/traces': {
        collect: true,
        items: [trace(), trace({ traceId: 'b'.repeat(32), status: 'error', errorCount: 1 })],
        next: null,
      },
      'GET /obs/traces/filters': FILTER_VALUES,
    });
    renderWithProviders(<Harness />);
    const list = await screen.findByRole('list', { name: 'Traces' });
    const [first, second] = within(list).getAllByRole('listitem');
    expect(first).toHaveTextContent('resume.match');
    expect(first).toHaveTextContent('claude-opus-5-5');
    expect(first).toHaveTextContent('1.23 s');
    expect(first).toHaveTextContent('1,200 in');
    expect(first).toHaveTextContent('340 out');
    expect(first).toHaveTextContent('$0.0123');
    expect(first).toHaveTextContent('OK');
    expect(second).toHaveTextContent('Error');
    // Each trace opens by keyboard: it is a link.
    expect(within(first!).getByRole('link')).toHaveAttribute(
      'href',
      '/settings/traces/0af7651916cd43dd8448eb211c80319c',
    );
  });

  it('sends each filter to the server as a bound query value', async () => {
    const { calls } = mockApi({
      'GET /obs/traces': { collect: true, items: [], next: null },
      'GET /obs/traces/filters': FILTER_VALUES,
    });
    renderWithProviders(<Harness />);
    const user = userEvent.setup();
    // The choices are the caller's own values, from the server: wait for them.
    await screen.findByRole('option', { name: 'resume.tailor' });
    await user.selectOptions(screen.getByLabelText('Task'), 'resume.tailor');
    await user.selectOptions(screen.getByLabelText('Model'), 'gpt-5');
    await user.selectOptions(screen.getByLabelText('Provider'), 'openai');
    await user.selectOptions(screen.getByLabelText('Status'), 'error');
    await user.selectOptions(screen.getByLabelText('Time range'), '24h');
    await screen.findByText(/No traces match/);
    const last = new URLSearchParams(calls.filter((c) => c.path === '/obs/traces').at(-1)!.search);
    expect(last.get('task')).toBe('resume.tailor');
    expect(last.get('model')).toBe('gpt-5');
    expect(last.get('provider')).toBe('openai');
    expect(last.get('status')).toBe('error');
    expect(Number(last.get('from'))).toBeGreaterThan(Date.now() - 24 * 3_600_000 - 60_000);
  });

  it('groups a chat’s turns under one conversation, and can show that conversation alone', async () => {
    const conv = '11111111-2222-3333-4444-555555555555';
    const { calls } = mockApi({
      'GET /obs/traces': {
        collect: true,
        items: [
          trace({
            traceId: '1'.repeat(32),
            startedAt: T0 + 3000,
            conversationId: conv,
            tasks: ['resume.tailor'],
          }),
          trace({ traceId: '2'.repeat(32), startedAt: T0 + 2000 }),
          trace({
            traceId: '3'.repeat(32),
            startedAt: T0 + 1000,
            conversationId: conv,
            tasks: ['resume.tailor'],
          }),
        ],
        next: null,
      },
      'GET /obs/traces/filters': FILTER_VALUES,
    });
    renderWithProviders(<Harness />);
    const group = await screen.findByRole('group', { name: /Tailoring chat, 2 turns/ });
    const turns = within(group).getAllByRole('link');
    expect(turns.map((l) => l.getAttribute('href'))).toEqual([
      `/settings/traces/${'1'.repeat(32)}`,
      `/settings/traces/${'3'.repeat(32)}`,
    ]);
    // The conversation's id is a row id: used for the filter, never printed.
    expect(document.body).not.toHaveTextContent(conv);
    await userEvent
      .setup()
      .click(within(group).getByRole('button', { name: 'Show only this conversation' }));
    await screen.findByRole('button', { name: 'Show all traces' });
    const last = new URLSearchParams(calls.filter((c) => c.path === '/obs/traces').at(-1)!.search);
    expect(last.get('conversation')).toBe(conv);
  });

  it('pages with Load more', async () => {
    const { calls } = mockApi({
      'GET /obs/traces': (call: { search: string }) =>
        new URLSearchParams(call.search).get('cursor') === 'c1'
          ? {
              collect: true,
              items: [trace({ traceId: 'd'.repeat(32), tasks: ['resume.tailor'] })],
              next: null,
            }
          : { collect: true, items: [trace()], next: 'c1' },
      'GET /obs/traces/filters': FILTER_VALUES,
    });
    renderWithProviders(<Harness />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Load more' }));
    const list = await screen.findByRole('list', { name: 'Traces' });
    await within(list).findByText('resume.tailor');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(calls.some((c) => c.search.includes('cursor=c1'))).toBe(true);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('reads a time range once: Load more pages through the same window', async () => {
    // A range becomes a start time when the list is first read. If Load more took "now" again,
    // the window would move forward and the traces between the two starts would be skipped
    // (tl on https://github.com/bgoleno/opportun/pull/361).
    let clock = Date.UTC(2026, 10, 2, 9, 0, 0);
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const { calls } = mockApi({
      'GET /obs/traces': (call: { search: string }) =>
        new URLSearchParams(call.search).get('cursor') === 'c1'
          ? { collect: true, items: [trace({ traceId: 'd'.repeat(32) })], next: null }
          : { collect: true, items: [trace()], next: 'c1' },
      'GET /obs/traces/filters': FILTER_VALUES,
    });
    renderWithProviders(<Harness initial={{ range: '24h' }} />);
    const more = await screen.findByRole('button', { name: 'Load more' });
    clock += 3_600_000;
    await userEvent.setup().click(more);
    await waitFor(() => expect(calls.filter((c) => c.path === '/obs/traces')).toHaveLength(2));
    const [first, second] = calls
      .filter((c) => c.path === '/obs/traces')
      .map((c) => new URLSearchParams(c.search).get('from'));
    expect(second).toBe(first);
  });

  it('where collection is unavailable, says so, to an admin too, and offers no switch (#364)', async () => {
    mockApi({
      'GET /obs/traces': { collect: false, collectAvailable: false, items: [], next: null },
      'GET /obs/traces/filters': FILTER_VALUES,
    });
    renderWithProviders(<Harness isAdmin />);
    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('Collection is not available on this deployment');
    expect(notice).not.toHaveTextContent(/off|turn it on|Ask an admin/i);
    expect(within(notice).queryByRole('link')).toBeNull();
  });

  it('while collection is off, links an admin to the switch in Settings > Telemetry', async () => {
    mockApi({
      'GET /obs/traces': { collect: false, collectAvailable: true, items: [], next: null },
      'GET /obs/traces/filters': FILTER_VALUES,
    });
    renderWithProviders(<Harness isAdmin />);
    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('Collection is off');
    // FR-T2's card exists now, so the words become a link (tl on #347; decision 41).
    expect(within(notice).getByRole('link', { name: 'Settings > Telemetry' })).toHaveAttribute(
      'href',
      '/settings/telemetry',
    );
  });

  it('while collection is off, tells a user to ask an admin, and still lists earlier traces', async () => {
    mockApi({
      'GET /obs/traces': { collect: false, collectAvailable: true, items: [trace()], next: null },
      'GET /obs/traces/filters': FILTER_VALUES,
    });
    renderWithProviders(<Harness />);
    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('Collection is off');
    expect(notice).toHaveTextContent(/Ask an admin/);
    expect(within(notice).queryByRole('link')).toBeNull();
    expect(notice).toHaveTextContent(/collected earlier are still shown/);
    expect(await screen.findByRole('list', { name: 'Traces' })).toBeInTheDocument();
  });
});

const ROOT = 'a000000000000001';
const CHILD = 'a000000000000002';
const GRANDCHILD = 'a000000000000003';

const span = (over: Partial<SpanView>): SpanView => ({
  spanId: ROOT,
  parentSpanId: null,
  name: 'span',
  kind: 'internal',
  startedAt: T0,
  durationMs: 1000,
  status: 'ok',
  errorType: null,
  task: null,
  model: null,
  provider: null,
  attributes: {},
  prompt: null,
  ...over,
});

const DETAIL = {
  trace: trace({
    workflow: 'tailoring_chat',
    conversationId: '9'.repeat(8),
    durationMs: 1000,
    spanCount: 3,
    truncated: true,
  }),
  spans: [
    span({ spanId: ROOT, name: 'invoke_workflow tailoring_chat' }),
    span({
      spanId: CHILD,
      parentSpanId: ROOT,
      name: 'chat claude-opus-5-5',
      kind: 'client',
      startedAt: T0 + 100,
      durationMs: 800,
      task: 'resume.tailor',
      model: 'claude-opus-5-5',
      provider: 'anthropic',
      attributes: { 'gen_ai.usage.input_tokens': 1200, 'gen_ai.response.finish_reasons': ['stop'] },
      prompt: { name: 'resume.tailor', version: 3 },
    }),
    span({
      spanId: GRANDCHILD,
      parentSpanId: CHILD,
      name: 'POST',
      kind: 'client',
      startedAt: T0 + 150,
      durationMs: 600,
      status: 'error',
      errorType: 'provider_error',
      attributes: { 'http.request.method': 'POST', 'opportun.outbound.target': 'anthropic' },
    }),
  ],
  conversation: { id: '9'.repeat(8), resumeId: 'resume-1' },
};

/** Renders `ui` with a query client set up as the app's own (app.tsx: retry 1), unlike the
 * test helper, which turns retries off. */
function renderAsApp(ui: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
  const rootRoute = createRootRoute({ component: () => ui });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory() });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('TraceDetailPage', () => {
  it('shows every span on one axis, nested by parent, with its duration', async () => {
    mockApi({ [`GET /obs/traces/${DETAIL.trace.traceId}`]: DETAIL });
    renderWithProviders(<TraceDetailPage traceId={DETAIL.trace.traceId} />);
    const tree = await screen.findByRole('tree', { name: 'Spans' });
    const items = within(tree).getAllByRole('treeitem');
    expect(items.map((i) => [i.getAttribute('aria-level'), i.textContent])).toEqual([
      ['1', expect.stringContaining('invoke_workflow tailoring_chat')],
      ['2', expect.stringContaining('chat claude-opus-5-5')],
      ['3', expect.stringContaining('POST')],
    ]);
    expect(items[1]).toHaveTextContent('800 ms');
    expect(items[1]).toHaveTextContent('+100 ms');
    expect(items[2]).toHaveTextContent('provider_error');
    expect(screen.getByText(/truncated/i)).toBeInTheDocument();
  });

  it('shows a span’s attributes when it is selected, by click or by keyboard', async () => {
    mockApi({ [`GET /obs/traces/${DETAIL.trace.traceId}`]: DETAIL });
    renderWithProviders(<TraceDetailPage traceId={DETAIL.trace.traceId} />);
    const user = userEvent.setup();
    const tree = await screen.findByRole('tree', { name: 'Spans' });
    const [root, child, grandchild] = within(tree).getAllByRole('treeitem');
    // The first span is selected to begin with.
    expect(root).toHaveAttribute('aria-selected', 'true');
    await user.click(child!);
    const details = screen.getByRole('region', { name: /Span details/ });
    expect(details).toHaveTextContent('gen_ai.usage.input_tokens');
    expect(details).toHaveTextContent('1200');
    expect(details).toHaveTextContent('stop');
    // Arrow keys move through the spans and select as they go; Home and End jump.
    await user.keyboard('{ArrowDown}');
    expect(grandchild).toHaveFocus();
    expect(grandchild).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('region', { name: /Span details/ })).toHaveTextContent(
      'opportun.outbound.target',
    );
    await user.keyboard('{Home}');
    expect(root).toHaveFocus();
    await user.keyboard('{End}');
    expect(grandchild).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(child).toHaveFocus();
    // Only the selected span is in the tab order.
    expect(
      within(tree)
        .getAllByRole('treeitem')
        .map((i) => i.tabIndex),
    ).toEqual([-1, 0, -1]);
  });

  it('links to where the content lives: the tailoring session and the prompt, by name and version', async () => {
    mockApi({ [`GET /obs/traces/${DETAIL.trace.traceId}`]: DETAIL });
    renderWithProviders(<TraceDetailPage traceId={DETAIL.trace.traceId} />);
    const user = userEvent.setup();
    expect(await screen.findByRole('link', { name: 'Open the tailoring session' })).toHaveAttribute(
      'href',
      '/resumes/resume-1',
    );
    await user.click(
      within(screen.getByRole('tree', { name: 'Spans' })).getAllByRole('treeitem')[1]!,
    );
    const details = screen.getByRole('region', { name: /Span details/ });
    expect(details).toHaveTextContent('resume.tailor, version 3');
    expect(within(details).getByRole('link', { name: /prompts/i })).toHaveAttribute(
      'href',
      '/settings/ai',
    );
    expect(document.body).not.toHaveTextContent('9'.repeat(8));
  });

  it('says a trace is not found at once, without retrying the 404 (#365)', async () => {
    const { calls } = mockApi({});
    renderAsApp(<TraceDetailPage traceId={'e'.repeat(32)} />);
    // Well inside the 1 s a retry waits before its second request.
    expect(await screen.findByText(/not found/i, {}, { timeout: 500 })).toBeInTheDocument();
    expect(calls.filter((c) => c.path === `/obs/traces/${'e'.repeat(32)}`)).toHaveLength(1);
  });

  it('reads an upper-case trace id as the same id, in lower case (#370)', async () => {
    const { calls } = mockApi({ [`GET /obs/traces/${DETAIL.trace.traceId}`]: DETAIL });
    renderAsApp(<TraceDetailPage traceId={DETAIL.trace.traceId.toUpperCase()} />);
    expect(await screen.findByRole('tree', { name: 'Spans' })).toBeInTheDocument();
    expect(calls.map((c) => c.path)).toEqual([`/obs/traces/${DETAIL.trace.traceId}`]);
  });

  it.each([['not-a-trace'], ['g'.repeat(32)], ['a'.repeat(31)], ['a'.repeat(33)]])(
    'says an id of the wrong shape (%s) is not found, without asking the server (#370)',
    async (id) => {
      const { calls } = mockApi({});
      renderAsApp(<TraceDetailPage traceId={id} />);
      expect(await screen.findByText(/Trace not found/)).toBeInTheDocument();
      expect(calls.filter((c) => c.path.startsWith('/obs/traces'))).toEqual([]);
    },
  );

  it('says a trace the server refuses (400) is not found, at once and without its text (#370)', async () => {
    const { calls } = mockApi({
      [`GET /obs/traces/${'e'.repeat(32)}`]: () => ({
        status: 400,
        body: { error: { code: 'validation', message: 'params/traceId must match pattern' } },
      }),
    });
    renderAsApp(<TraceDetailPage traceId={'e'.repeat(32)} />);
    expect(await screen.findByText(/Trace not found/, {}, { timeout: 500 })).toBeInTheDocument();
    expect(screen.queryByText(/pattern|validation/i)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('says so when the trace is not found', async () => {
    mockApi({});
    renderWithProviders(<TraceDetailPage traceId={'f'.repeat(32)} />);
    expect(await screen.findByText(/not found/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /All traces/ })).toHaveAttribute(
      'href',
      '/settings/traces',
    );
  });
});
