import type { DndContextProps, DragEndEvent } from '@dnd-kit/core';
import type { OpportunityStage } from '@opportun/core';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { OpportunityView } from '@/lib/opportunities';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { KanbanCard } from './KanbanCard';
import type { StageFlow } from '@/components/stage/useStageFlow';
import { COLLAPSED_STORAGE_KEY, Pipeline, type PipelineSearch } from './Pipeline';

// Capture the props the board hands to DndContext so a drop can be driven directly
// (jsdom has no layout, so pointer-driven dragging cannot resolve a drop target).
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

function opp(
  id: string,
  companyName: string,
  title: string,
  stage: OpportunityStage,
  updatedAt = NOW,
  sortOrder = 0,
): OpportunityView {
  return {
    id,
    userId: 'u1',
    companyId: `c-${id}`,
    companyName,
    companyDomain: null,
    title,
    stage,
    sourceKind: 'manual',
    priority: 2,
    sortOrder,
    possibleDuplicates: [],
    descriptionIsUserWritten: false,
    hasCapturedPage: false,
    createdAt: NOW,
    updatedAt,
  } as OpportunityView;
}

const FIXTURE = [
  opp('opp-1', 'Acme', 'Staff PM', 'discovered', NOW - 1, 0),
  opp('opp-2', 'Globex', 'Principal Engineer', 'discovered', NOW - 2, 10),
  opp('opp-3', 'Initech', 'Director', 'applied', NOW - 3),
  opp('opp-4', 'Umbrella', 'VP Product', 'closed', NOW - 4),
];

function routes(stage?: (call: ApiCall) => unknown, reorder?: (call: ApiCall) => unknown) {
  // The server's view of the world: successful moves persist, so refetches agree.
  const items = FIXTURE.map((o) => ({ ...o }));
  const ok = (call: ApiCall) => {
    const id = call.path.split('/')[2] ?? '';
    const current = items.find((o) => o.id === id);
    if (current === undefined) return { status: 404, body: { error: { code: 'not_found' } } };
    current.stage = (call.body as { to: OpportunityStage }).to;
    return { ...current };
  };
  const reorderOk = (call: ApiCall) => {
    const { changes } = call.body as { changes: { id: string; sortOrder: number }[] };
    for (const c of changes) {
      const current = items.find((o) => o.id === c.id);
      if (current !== undefined) current.sortOrder = c.sortOrder;
    }
    return { status: 204 };
  };
  return {
    'GET /opportunities': () => ({ items, total: items.length }),
    'GET /dashboard': {
      stageCounts: {},
      dueNextSteps: [],
      recentActivity: [],
      needsTriage: { communications: 0 },
    },
    'POST /opportunities/opp-1/stage': stage ?? ok,
    'POST /opportunities/opp-2/stage': ok,
    'POST /opportunities/opp-3/stage': ok,
    'POST /opportunities/opp-4/stage': ok,
    'POST /opportunities/reorder': reorder ?? reorderOk,
  };
}

function Harness({ initial = {} }: { initial?: PipelineSearch }) {
  const [search, setSearch] = useState<PipelineSearch>(initial);
  return <Pipeline search={search} onSearchChange={(p) => setSearch((s) => ({ ...s, ...p }))} />;
}

async function renderBoard(
  stage?: (call: ApiCall) => unknown,
  initial: PipelineSearch = {},
  reorder?: (call: ApiCall) => unknown,
) {
  const api = mockApi(routes(stage, reorder));
  const user = userEvent.setup();
  const utils = renderWithProviders(<Harness initial={initial} />, { path: '/pipeline' });
  await screen.findByRole('article', { name: /Acme/ });
  return { api, user, ...utils };
}

function column(name: string) {
  return screen.getByRole('region', { name: `${name} column` });
}

async function drop(activeId: string, overId: string | null) {
  const onDragEnd = dnd.props?.onDragEnd;
  if (!onDragEnd) throw new Error('DndContext not rendered');
  await act(async () => {
    onDragEnd({
      active: { id: activeId },
      over: overId === null ? null : { id: overId },
    } as unknown as DragEndEvent);
  });
}

const stageCalls = (calls: ApiCall[]) =>
  calls.filter((c) => c.method === 'POST' && c.path.endsWith('/stage'));
const reorderCalls = (calls: ApiCall[]) =>
  calls.filter((c) => c.method === 'POST' && c.path === '/opportunities/reorder');

describe('Kanban drag and drop', () => {
  it('collapses the terminal columns by default', async () => {
    await renderBoard();
    expect(within(column('New')).getAllByRole('article')).toHaveLength(2);
    expect(within(column('Closed')).queryByRole('article')).toBeNull();
    expect(
      within(column('Closed')).getByRole('button', { name: 'Expand Closed (1)' }),
    ).toBeInTheDocument();
  });

  it('calls the stage endpoint with the dropped column as the target', async () => {
    const { api } = await renderBoard();
    await drop('opp-1', 'interested');
    await waitFor(() => expect(stageCalls(api.calls)).toHaveLength(1));
    expect(stageCalls(api.calls)[0]).toMatchObject({
      path: '/opportunities/opp-1/stage',
      body: { to: 'interested' },
    });
    await waitFor(() =>
      expect(within(column('Interested')).getByRole('article', { name: /Acme/ })).toBeVisible(),
    );
  });

  it('moves the card at once, then snaps back and shows the message on a 422', async () => {
    let reject: (v: unknown) => void = () => undefined;
    const pending = new Promise((resolve) => {
      reject = resolve;
    });
    await renderBoard(() => pending);
    await drop('opp-1', 'interested');

    // Optimistic: the card sits in the target column while the request is in flight.
    expect(within(column('Interested')).getByRole('article', { name: /Acme/ })).toBeVisible();

    await act(async () => {
      reject({
        status: 422,
        body: {
          error: {
            code: 'invalid_transition',
            message: 'Invalid stage transition discovered -> interested',
          },
        },
      });
    });
    await waitFor(() =>
      expect(within(column('New')).getByRole('article', { name: /Acme/ })).toBeVisible(),
    );
    expect(within(column('Interested')).queryByRole('article', { name: /Acme/ })).toBeNull();
    expect(
      await screen.findByText('Invalid stage transition discovered -> interested'),
    ).toBeInTheDocument();
  });

  it('does nothing when dropped on its own column or outside any column', async () => {
    const { api } = await renderBoard();
    await drop('opp-1', 'discovered');
    await drop('opp-1', null);
    expect(stageCalls(api.calls)).toHaveLength(0);
  });

  it('refuses a move the state machine forbids without a request', async () => {
    const { api } = await renderBoard();
    await drop('opp-3', 'discovered');
    expect(await screen.findByText('Applied cannot move to New.')).toBeInTheDocument();
    expect(stageCalls(api.calls)).toHaveLength(0);
    expect(within(column('Applied')).getByRole('article', { name: /Initech/ })).toBeVisible();
  });

  it('asks for a closed reason before closing, and cancel sends nothing', async () => {
    const { api, user } = await renderBoard();
    await drop('opp-3', 'closed');
    const dialog = await screen.findByRole('dialog', { name: 'Close opportunity' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(stageCalls(api.calls)).toHaveLength(0);
    expect(within(column('Applied')).getByRole('article', { name: /Initech/ })).toBeVisible();

    await drop('opp-3', 'closed');
    const again = await screen.findByRole('dialog', { name: 'Close opportunity' });
    await user.click(within(again).getByRole('button', { name: 'Close opportunity' }));
    expect(await within(again).findByText('Choose a reason')).toBeInTheDocument();
    await user.selectOptions(within(again).getByLabelText('Reason'), 'rejected');
    await user.click(within(again).getByRole('button', { name: 'Close opportunity' }));
    await waitFor(() => expect(stageCalls(api.calls)).toHaveLength(1));
    expect(stageCalls(api.calls)[0]?.body).toEqual({ to: 'closed', closedReason: 'rejected' });
  });

  it('asks for a dismiss reason and note when dropped on Dismissed', async () => {
    const { api, user } = await renderBoard();
    await drop('opp-2', 'dismissed');
    const dialog = await screen.findByRole('dialog', { name: 'Dismiss opportunity' });
    await user.selectOptions(within(dialog).getByLabelText('Reason'), 'location');
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'Onsite only');
    await user.click(within(dialog).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(stageCalls(api.calls)).toHaveLength(1));
    expect(stageCalls(api.calls)[0]).toMatchObject({
      path: '/opportunities/opp-2/stage',
      body: { to: 'dismissed', dismissedReason: 'location', note: 'Onsite only' },
    });
  });
});

describe('Card controls', () => {
  it('dismisses from the card button with a reason', async () => {
    const { api, user } = await renderBoard();
    const card = within(column('New')).getByRole('article', { name: /Globex/ });
    await user.click(within(card).getByRole('button', { name: 'Dismiss' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dismiss opportunity' });
    await user.selectOptions(within(dialog).getByLabelText('Reason'), 'seniority');
    await user.click(within(dialog).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(stageCalls(api.calls)).toHaveLength(1));
    expect(stageCalls(api.calls)[0]?.body).toEqual({
      to: 'dismissed',
      dismissedReason: 'seniority',
    });
  });

  it('moves a card from its stage menu without a mouse drag', async () => {
    const { api, user } = await renderBoard();
    const card = within(column('Applied')).getByRole('article', { name: /Initech/ });
    await user.click(within(card).getByRole('button', { name: 'Move Initech: Director' }));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((m) => m.textContent),
    ).toEqual(['Preparing', 'In process', 'Offer', 'Dismissed', 'Closed']);
    await user.click(within(menu).getByRole('menuitem', { name: 'In process' }));
    await waitFor(() => expect(stageCalls(api.calls)).toHaveLength(1));
    expect(stageCalls(api.calls)[0]?.body).toEqual({ to: 'in_process' });
  });

  it('reopens a closed card only through the explicit Reopen action', async () => {
    const { api, user } = await renderBoard();
    await user.click(within(column('Closed')).getByRole('button', { name: 'Expand Closed (1)' }));
    const card = within(column('Closed')).getByRole('article', { name: /Umbrella/ });
    await user.click(within(card).getByRole('button', { name: 'Move Umbrella: VP Product' }));
    const menu = await screen.findByRole('menu');
    // The normal moves out of closed are only terminal ones; chain stages are reopen items.
    await user.click(within(menu).getByRole('menuitem', { name: 'Reopen as Applied' }));
    await waitFor(() => expect(stageCalls(api.calls)).toHaveLength(1));
    expect(stageCalls(api.calls)[0]?.body).toEqual({ to: 'applied', reopen: true });
  });
});

describe('Keyboard triage', () => {
  function selected() {
    return screen
      .queryAllByRole('article')
      .filter((a) => a.getAttribute('aria-current') === 'true');
  }

  it('j and k move the selection through the cards in board order', async () => {
    const { user } = await renderBoard();
    await user.keyboard('j');
    expect(selected().map((a) => a.getAttribute('aria-label'))).toEqual(['Acme: Staff PM']);
    expect(document.activeElement).toBe(selected()[0]);
    await user.keyboard('j');
    expect(selected()[0]).toHaveAccessibleName('Globex: Principal Engineer');
    await user.keyboard('j');
    expect(selected()[0]).toHaveAccessibleName('Initech: Director');
    await user.keyboard('j');
    expect(selected()[0]).toHaveAccessibleName('Initech: Director');
    await user.keyboard('k');
    expect(selected()[0]).toHaveAccessibleName('Globex: Principal Engineer');
  });

  it('i marks the selected opportunity interested', async () => {
    const { api, user } = await renderBoard();
    await user.keyboard('jj');
    await user.keyboard('i');
    await waitFor(() => expect(stageCalls(api.calls)).toHaveLength(1));
    expect(stageCalls(api.calls)[0]).toMatchObject({
      path: '/opportunities/opp-2/stage',
      body: { to: 'interested' },
    });
  });

  it('x opens the dismiss dialog for the selection', async () => {
    const { api, user } = await renderBoard();
    await user.keyboard('j');
    await user.keyboard('x');
    const dialog = await screen.findByRole('dialog', { name: 'Dismiss opportunity' });
    expect(dialog).toHaveTextContent('Acme: Staff PM');
    await user.selectOptions(within(dialog).getByLabelText('Reason'), 'compensation');
    await user.click(within(dialog).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(stageCalls(api.calls)).toHaveLength(1));
    expect(stageCalls(api.calls)[0]).toMatchObject({
      path: '/opportunities/opp-1/stage',
      body: { to: 'dismissed', dismissedReason: 'compensation' },
    });
  });

  it('enter opens the selected opportunity', async () => {
    const { user, router } = await renderBoard();
    await user.keyboard('jj{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/opportunities/opp-2'));
  });

  it('ignores triage keys while typing in the filter', async () => {
    const { api, user } = await renderBoard();
    await user.type(screen.getByRole('searchbox', { name: 'Filter opportunities' }), 'jix');
    expect(selected()).toHaveLength(0);
    expect(stageCalls(api.calls)).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Collapsible columns', () => {
  const stored = () => JSON.parse(window.localStorage.getItem(COLLAPSED_STORAGE_KEY) ?? 'null');

  it('collapses a non-terminal column to a rail with its count, and expands it back', async () => {
    const { user } = await renderBoard();
    await user.click(within(column('New')).getByRole('button', { name: 'Collapse New' }));
    expect(within(column('New')).queryByRole('article')).toBeNull();
    const rail = within(column('New')).getByRole('button', {
      name: 'Expand New (2)',
    });
    expect(rail).toHaveAttribute('aria-expanded', 'false');
    expect(rail).toHaveTextContent('2');
    expect(within(column('New')).queryByRole('button', { name: /^Collapse/ })).toBeNull();

    await user.click(rail);
    expect(within(column('New')).getAllByRole('article')).toHaveLength(2);
    expect(within(column('New')).getByRole('button', { name: 'Collapse New' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(within(column('New')).queryByRole('button', { name: /^Expand/ })).toBeNull();
  });

  it('persists the collapsed set to localStorage and restores it on the next render', async () => {
    const { user, unmount } = await renderBoard();
    await user.click(within(column('Applied')).getByRole('button', { name: 'Collapse Applied' }));
    await user.click(within(column('Closed')).getByRole('button', { name: 'Expand Closed (1)' }));
    expect(new Set(stored())).toEqual(new Set(['applied', 'dismissed']));
    unmount();

    await renderBoard();
    expect(
      within(column('Applied')).getByRole('button', { name: 'Expand Applied (1)' }),
    ).toBeVisible();
    expect(within(column('Closed')).getByRole('article', { name: /Umbrella/ })).toBeVisible();
    expect(
      within(column('Dismissed')).getByRole('button', { name: 'Expand Dismissed (0)' }),
    ).toBeVisible();
  });

  it('falls back to the default layout when the stored value is corrupt', async () => {
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, '{not json');
    await renderBoard();
    expect(within(column('New')).getAllByRole('article')).toHaveLength(2);
    expect(
      within(column('Closed')).getByRole('button', { name: 'Expand Closed (1)' }),
    ).toBeVisible();
  });

  it('still accepts drops on a collapsed column', async () => {
    window.localStorage.setItem(
      COLLAPSED_STORAGE_KEY,
      JSON.stringify(['interested', 'closed', 'dismissed']),
    );
    const { api } = await renderBoard();
    expect(
      within(column('Interested')).getByRole('button', { name: 'Expand Interested (0)' }),
    ).toBeVisible();
    await drop('opp-1', 'interested');
    await waitFor(() => expect(stageCalls(api.calls)).toHaveLength(1));
    expect(stageCalls(api.calls)[0]).toMatchObject({
      path: '/opportunities/opp-1/stage',
      body: { to: 'interested' },
    });
    await waitFor(() =>
      expect(
        within(column('Interested')).getByRole('button', { name: 'Expand Interested (1)' }),
      ).toBeVisible(),
    );
  });

  it('opens the reason dialogs when dropped on the collapsed closed and dismissed rails', async () => {
    const { user } = await renderBoard();
    expect(
      within(column('Closed')).getByRole('button', { name: 'Expand Closed (1)' }),
    ).toBeVisible();
    await drop('opp-3', 'closed');
    const close = await screen.findByRole('dialog', { name: 'Close opportunity' });
    await user.click(within(close).getByRole('button', { name: 'Cancel' }));
    await drop('opp-2', 'dismissed');
    expect(await screen.findByRole('dialog', { name: 'Dismiss opportunity' })).toBeInTheDocument();
  });

  it('j and k skip cards in collapsed columns', async () => {
    const { user } = await renderBoard();
    await user.click(within(column('New')).getByRole('button', { name: 'Collapse New' }));
    await user.keyboard('j');
    const current = screen
      .queryAllByRole('article')
      .filter((a) => a.getAttribute('aria-current') === 'true');
    expect(current.map((a) => a.getAttribute('aria-label'))).toEqual(['Initech: Director']);
  });
});

describe('posting reconciliation mark (design D9)', () => {
  // Rendered directly rather than through the board: the mark is a property of one card, and
  // the board's fixture is shared by every other test in this file.
  const flow = {
    dismiss: () => {},
    move: () => {},
    pending: null,
    close: () => {},
  } as unknown as StageFlow;

  const card = (over: Partial<OpportunityView>) =>
    renderWithProviders(
      <KanbanCard
        opp={{ ...opp('o1', 'Soylent', 'Staff Product Manager', 'interested'), ...over }}
        selected={false}
        dueAt={undefined}
        flow={flow}
        onSelect={() => {}}
      />,
    );

  it('marks a card whose posting could not be confirmed', async () => {
    card({ postingState: 'needs_review', postingStateDetail: 'ambiguous' });
    expect(await screen.findByText(/posting unconfirmed/i)).toBeInTheDocument();
  });

  it('leaves a confirmed card unmarked', async () => {
    card({ postingState: 'confirmed' });
    await screen.findByText('Staff Product Manager');
    expect(screen.queryByText(/posting unconfirmed/i)).not.toBeInTheDocument();
  });

  it('leaves a card nobody reconciled unmarked', async () => {
    card({});
    await screen.findByText('Staff Product Manager');
    expect(screen.queryByText(/posting unconfirmed/i)).not.toBeInTheDocument();
  });
});

describe('possible-duplicate mark (#9)', () => {
  const flow = {
    dismiss: () => {},
    move: () => {},
    pending: null,
    close: () => {},
  } as unknown as StageFlow;

  const card = (over: Partial<OpportunityView>) =>
    renderWithProviders(
      <KanbanCard
        opp={{ ...opp('o1', 'Soylent', 'Staff Product Manager', 'interested'), ...over }}
        selected={false}
        dueAt={undefined}
        flow={flow}
        onSelect={() => {}}
      />,
    );

  it('marks a card flagged as a possible duplicate', async () => {
    card({ possibleDuplicates: ['o2'] });
    expect(await screen.findByText(/possible duplicate/i)).toBeInTheDocument();
  });

  it('leaves an unflagged card unmarked', async () => {
    card({ possibleDuplicates: [] });
    await screen.findByText('Staff Product Manager');
    expect(screen.queryByText(/possible duplicate/i)).not.toBeInTheDocument();
  });
});

describe('origin badge (#201)', () => {
  const flow = {
    dismiss: () => {},
    move: () => {},
    pending: null,
    close: () => {},
  } as unknown as StageFlow;

  const card = (over: Partial<OpportunityView>) =>
    renderWithProviders(
      <KanbanCard
        opp={{ ...opp('o1', 'Soylent', 'Staff Product Manager', 'interested'), ...over }}
        selected={false}
        dueAt={undefined}
        flow={flow}
        onSelect={() => {}}
      />,
    );

  it('names the consent an inbox-created card never asked for', async () => {
    card({ sourceKind: 'communication' });
    expect(await screen.findByText('From a message')).toBeInTheDocument();
  });

  it('names a card the user actually accepted from discovery', async () => {
    card({ sourceKind: 'discovery' });
    expect(await screen.findByText('Discovery')).toBeInTheDocument();
  });

  it('is always present, even on a card with nothing else to show', async () => {
    card({ sourceKind: 'manual' });
    expect(await screen.findByText('Added manually')).toBeInTheDocument();
  });
});

describe('manual order within a column (issue #240)', () => {
  it('drops a card onto another card in the same column to reorder, not move stage, in one request', async () => {
    const { api } = await renderBoard();
    // opp-1 (sortOrder 0) onto opp-2 (sortOrder 10), both in `discovered`.
    await drop('opp-1', 'opp-2');
    expect(stageCalls(api.calls)).toHaveLength(0);
    await waitFor(() => expect(reorderCalls(api.calls)).toHaveLength(1));
    const { changes } = reorderCalls(api.calls)[0]!.body as {
      changes: { id: string; sortOrder: number }[];
    };
    const byId = (id: string) => changes.find((c) => c.id === id);
    expect(byId('opp-2')?.sortOrder).toBe(0);
    expect(byId('opp-1')?.sortOrder).toBe(10);
  });

  it('dropping on a card in a different column still moves stage, not a reorder', async () => {
    const { api } = await renderBoard();
    await drop('opp-1', 'opp-3');
    await waitFor(() => expect(stageCalls(api.calls)).toHaveLength(1));
    expect(stageCalls(api.calls)[0]?.body).toEqual({ to: 'applied' });
    expect(reorderCalls(api.calls)).toHaveLength(0);
  });

  it('does not reorder while a text filter is active, and says why', async () => {
    // 'e' matches both Acme and Globex, so both stay visible -- the point is that *any*
    // active filter disables in-column reorder, not just one that happens to hide this pair
    // (the real-world gap the issue names is a filter hiding some OTHER sibling's rank).
    const { api } = await renderBoard(undefined, { q: 'e' });
    await drop('opp-1', 'opp-2');
    expect(await screen.findByText('Reordering is off while filtering')).toBeInTheDocument();
    expect(reorderCalls(api.calls)).toHaveLength(0);
    expect(stageCalls(api.calls)).toHaveLength(0);
  });

  it('explains the order/priority relationship on the board, not the table', async () => {
    const { user } = await renderBoard();
    expect(screen.getByText(/independent of its/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Table' }));
    expect(screen.queryByText(/independent of its/)).not.toBeInTheDocument();
  });

  it('persists manual order across a reload: lower sortOrder renders first', async () => {
    await renderBoard();
    const cards = within(column('New')).getAllByRole('article');
    // opp-1 (sortOrder 0) before opp-2 (sortOrder 10), same column.
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual([
      'Acme: Staff PM',
      'Globex: Principal Engineer',
    ]);
  });

  it('rolls back to the exact pre-drag order when the batch request fails', async () => {
    // A controlled, not-yet-resolved response: proves this is an actual rollback of a real
    // optimistic update, not just a final state that happens to match "nothing happened".
    let resolveReorder: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      resolveReorder = resolve;
    });
    const { api } = await renderBoard(undefined, {}, async () => {
      await pending;
      return { status: 500, body: { error: { code: 'server_error' } } };
    });
    await drop('opp-1', 'opp-2');
    // Optimistic update lands first: Globex (dropped onto) now before Acme.
    await waitFor(() =>
      expect(
        within(column('New'))
          .getAllByRole('article')
          .map((c) => c.textContent),
      ).toEqual([expect.stringContaining('Globex'), expect.stringContaining('Acme')]),
    );
    resolveReorder?.();
    // The failed request restores the pre-drag snapshot, not just a refetch guess: Acme
    // (sortOrder 0) back before Globex (sortOrder 10), as if the drag never happened.
    await waitFor(() =>
      expect(
        within(column('New'))
          .getAllByRole('article')
          .map((c) => c.textContent),
      ).toEqual([expect.stringContaining('Acme'), expect.stringContaining('Globex')]),
    );
    expect(await screen.findByText('Order not saved')).toBeInTheDocument();
    expect(reorderCalls(api.calls)).toHaveLength(1);
  });
});
