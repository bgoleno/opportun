// A change on the board costs a constant number of list requests, whatever the board's size
// (https://github.com/bgoleno/opportun/issues/589). The board loads every opportunity, in pages of
// 200; a stage change or a reorder used to invalidate every opportunity list, so each one walked
// all those pages again. The board must still show the server's state after a change, a failed
// one included, and the other lists must still refresh.
import type { DndContextProps, DragEndEvent } from '@dnd-kit/core';
import type { OpportunityStage } from '@opportun/core';
import { useQuery } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { qk, type OpportunityView, type Page } from '@/lib/opportunities';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { Pipeline, type PipelineSearch } from './Pipeline';

// The props the board hands to DndContext, so a drop can be driven directly (jsdom has no layout).
const dnd = vi.hoisted(() => ({ props: null as DndContextProps | null }));
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@dnd-kit/core')>();
  return {
    ...mod,
    DndContext: (props: DndContextProps) => {
      dnd.props = props;
      return <mod.DndContext {...props} />;
    },
  };
});

const NOW = 1_760_000_000_000;
const TOTAL = 1000;

function opp(i: number, stage: OpportunityStage, sortOrder = 0): OpportunityView {
  return {
    id: `opp-${i}`,
    userId: 'u1',
    companyId: `c-${i}`,
    companyName: `Company ${i}`,
    companyDomain: null,
    title: `Role ${i}`,
    stage,
    sourceKind: 'manual',
    priority: 2,
    sortOrder,
    possibleDuplicates: [],
    descriptionIsUserWritten: false,
    hasCapturedPage: false,
    lastActivityAt: null,
    createdAt: NOW,
    updatedAt: NOW - i,
  } as OpportunityView;
}

/**
 * A fake server holding 1,000 opportunities: two open ones the tests move, the rest closed (the
 * Closed column starts collapsed, so the board renders few cards). The list answers by page, as
 * the real one does.
 */
function server(opts: {
  stage?: (call: ApiCall) => unknown;
  reorder?: (call: ApiCall) => unknown;
  /** The single-opportunity read fails (as a 404 does), so a refused move falls back. */
  noRowRead?: boolean;
}) {
  const items = [
    opp(1, 'discovered', 0),
    opp(2, 'discovered', 10),
    ...Array.from({ length: TOTAL - 2 }, (_, i) => opp(i + 3, 'closed')),
  ];
  const find = (id: string) => items.find((o) => o.id === id);
  const list = (call: ApiCall) => {
    const p = new URLSearchParams(call.search);
    const q = p.get('q')?.toLowerCase();
    const matching =
      q === undefined ? items : items.filter((o) => o.companyName.toLowerCase().includes(q));
    const offset = Number(p.get('offset') ?? 0);
    const limit = Number(p.get('limit') ?? 50);
    return { items: matching.slice(offset, offset + limit), total: matching.length };
  };
  const stageOk = (call: ApiCall) => {
    const current = find(call.path.split('/')[2] ?? '')!;
    current.stage = (call.body as { to: OpportunityStage }).to;
    current.updatedAt = NOW + 1;
    return { ...current };
  };
  const reorderOk = (call: ApiCall) => {
    for (const c of (call.body as { changes: { id: string; sortOrder: number }[] }).changes) {
      find(c.id)!.sortOrder = c.sortOrder;
    }
    return { status: 204 };
  };
  const one = (call: ApiCall) =>
    opts.noRowRead === true
      ? { status: 500, body: { error: { code: 'server_error' } } }
      : { ...find(call.path.split('/')[2] ?? '')! };
  return {
    items,
    routes: {
      'GET /opportunities': list,
      'GET /opportunities/opp-1': one,
      'GET /opportunities/opp-2': one,
      'GET /dashboard': {
        stageCounts: {},
        dueNextSteps: [],
        recentActivity: [],
        needsTriage: { communications: 0 },
      },
      'POST /opportunities/opp-1/stage': opts.stage ?? stageOk,
      'POST /opportunities/reorder': opts.reorder ?? reorderOk,
    },
  };
}

/** Another view reading an opportunity list (the shape of the inbox's opportunity picker). */
function OtherList() {
  const { data } = useQuery({
    queryKey: qk.opportunityList({ q: 'Company 1', picker: 'true' }),
    queryFn: () => api<Page<OpportunityView>>('/opportunities?q=Company%201&limit=10'),
  });
  return <p>Other list: {data === undefined ? 'loading' : `${data.total} found`}</p>;
}

function Harness() {
  const [search, setSearch] = useState<PipelineSearch>({});
  return (
    <>
      <Pipeline search={search} onSearchChange={(p) => setSearch((s) => ({ ...s, ...p }))} />
      <OtherList />
    </>
  );
}

const boardPages = (calls: ApiCall[]) =>
  calls.filter((c) => c.method === 'GET' && c.path === '/opportunities' && !c.search.includes('q='))
    .length;
const otherListGets = (calls: ApiCall[]) =>
  calls.filter((c) => c.method === 'GET' && c.path === '/opportunities' && c.search.includes('q='))
    .length;
const rowGets = (calls: ApiCall[], id: string) =>
  calls.filter((c) => c.method === 'GET' && c.path === `/opportunities/${id}`).length;

async function renderBoard(opts: Parameters<typeof server>[0] = {}) {
  const fake = server(opts);
  const mocked = mockApi(fake.routes);
  const utils = renderWithProviders(<Harness />, { path: '/pipeline' });
  await screen.findByRole('article', { name: /Company 1: Role 1/ });
  await screen.findByText('Other list: 112 found');
  // Every page of 200 once, to load the board.
  expect(boardPages(mocked.calls)).toBe(TOTAL / 200);
  expect(otherListGets(mocked.calls)).toBe(1);
  return { ...fake, ...mocked, ...utils };
}

/** Waits until the change has settled: the other list refetched and nothing is in flight. */
async function settled(
  calls: ApiCall[],
  queryClient: { isFetching: () => number; isMutating: () => number },
) {
  await waitFor(() => expect(otherListGets(calls)).toBeGreaterThanOrEqual(2));
  await waitFor(() => {
    expect(queryClient.isMutating()).toBe(0);
    expect(queryClient.isFetching()).toBe(0);
  });
}

function column(name: string) {
  return screen.getByRole('region', { name: `${name} column` });
}

async function drop(activeId: string, overId: string) {
  const onDragEnd = dnd.props?.onDragEnd;
  if (!onDragEnd) throw new Error('DndContext not rendered');
  await act(async () => {
    onDragEnd({ active: { id: activeId }, over: { id: overId } } as unknown as DragEndEvent);
  });
}

const cardOrder = (name: string) =>
  within(column(name))
    .getAllByRole('article')
    .map((c) => c.getAttribute('aria-label'));

describe('a change on a board of 1,000 opportunities (#589)', () => {
  it('a stage change sends no list request for the board, and the other list still refreshes', async () => {
    const { calls, queryClient } = await renderBoard();
    await drop('opp-1', 'interested');
    await settled(calls, queryClient);
    expect(boardPages(calls)).toBe(TOTAL / 200);
    expect(
      within(column('Interested')).getByRole('article', { name: /Company 1: Role 1/ }),
    ).toBeVisible();
  });

  it('a reorder sends no list request for the board, and the other list still refreshes', async () => {
    const { calls, queryClient } = await renderBoard();
    await drop('opp-1', 'opp-2');
    await settled(calls, queryClient);
    expect(boardPages(calls)).toBe(TOTAL / 200);
    expect(cardOrder('New')).toEqual(['Company 2: Role 2', 'Company 1: Role 1']);
  });

  it("a failed stage change shows the server's state from one request for that opportunity", async () => {
    let items: OpportunityView[] = [];
    const { calls, queryClient, ...fake } = await renderBoard({
      // Another tab already applied it: the server refuses the move and holds it in Applied.
      stage: () => {
        items.find((o) => o.id === 'opp-1')!.stage = 'applied';
        return {
          status: 422,
          body: {
            error: {
              code: 'invalid_transition',
              message: 'Invalid stage transition applied -> interested',
              from: 'applied',
              to: 'interested',
            },
          },
        };
      },
    });
    items = fake.items;
    await drop('opp-1', 'interested');
    await settled(calls, queryClient);
    expect(
      await within(column('Applied')).findByRole('article', { name: /Company 1: Role 1/ }),
    ).toBeVisible();
    expect(within(column('Interested')).queryByRole('article', { name: /Company 1/ })).toBeNull();
    expect(screen.getAllByText('Stage not changed').length).toBeGreaterThan(0);
    expect(boardPages(calls)).toBe(TOTAL / 200);
    expect(rowGets(calls, 'opp-1')).toBe(1);
  });

  it('a refused stage change whose read-back fails reads the whole board back instead', async () => {
    let items: OpportunityView[] = [];
    const { calls, queryClient, ...fake } = await renderBoard({
      noRowRead: true,
      stage: () => {
        items.find((o) => o.id === 'opp-1')!.stage = 'applied';
        return { status: 409, body: { error: { code: 'conflict' } } };
      },
    });
    items = fake.items;
    await drop('opp-1', 'interested');
    await settled(calls, queryClient);
    expect(
      await within(column('Applied')).findByRole('article', { name: /Company 1: Role 1/ }),
    ).toBeVisible();
    expect(rowGets(calls, 'opp-1')).toBe(1);
    expect(boardPages(calls)).toBe(2 * (TOTAL / 200));
  });

  it('a reorder the server refuses restores the order and says so, with no list request', async () => {
    // A definite 4xx: the batch was refused before anything was saved, so the snapshot is the
    // server's state.
    const { calls, queryClient } = await renderBoard({
      reorder: () => ({ status: 422, body: { error: { code: 'validation_failed' } } }),
    });
    await drop('opp-1', 'opp-2');
    await settled(calls, queryClient);
    expect(await screen.findByText('Order not saved')).toBeInTheDocument();
    expect(cardOrder('New')).toEqual(['Company 1: Role 1', 'Company 2: Role 2']);
    expect(boardPages(calls)).toBe(TOTAL / 200);
  });

  it('a reorder whose answer is lost after the server saved it reads the board back once', async () => {
    // The server committed the batch, then the answer failed (a proxy's 502, a dropped
    // connection): the outcome is unknown to the board, so it reads its list back, once.
    let items: OpportunityView[] = [];
    const { calls, queryClient, ...fake } = await renderBoard({
      reorder: (call) => {
        for (const c of (call.body as { changes: { id: string; sortOrder: number }[] }).changes) {
          items.find((o) => o.id === c.id)!.sortOrder = c.sortOrder;
        }
        return { status: 502, body: { error: { code: 'bad_gateway' } } };
      },
    });
    items = fake.items;
    await drop('opp-1', 'opp-2');
    await settled(calls, queryClient);
    expect(await screen.findByText('Order not saved')).toBeInTheDocument();
    await waitFor(() =>
      expect(cardOrder('New')).toEqual(['Company 2: Role 2', 'Company 1: Role 1']),
    );
    expect(boardPages(calls)).toBe(2 * (TOTAL / 200));
  });

  it('a reorder that fails without saving shows the old order after reading the board back', async () => {
    const { calls, queryClient } = await renderBoard({
      reorder: () => ({ status: 500, body: { error: { code: 'server_error' } } }),
    });
    await drop('opp-1', 'opp-2');
    await settled(calls, queryClient);
    expect(await screen.findByText('Order not saved')).toBeInTheDocument();
    expect(cardOrder('New')).toEqual(['Company 1: Role 1', 'Company 2: Role 2']);
    expect(boardPages(calls)).toBe(2 * (TOTAL / 200));
  });
});
