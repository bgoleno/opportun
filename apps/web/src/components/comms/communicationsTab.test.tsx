// An opportunity's linked messages, newest first by default with a control to read them oldest
// first (https://github.com/bgoleno/opportun/issues/394). The server answers the thread oldest
// first, ties by id; the tab only reorders what it was given.
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import type { CommunicationView } from './api';
import { CommunicationsTab } from './CommunicationsTab';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1, 12);

function message(id: string, subject: string, sentAt: number): CommunicationView {
  return {
    id,
    channel: 'gmail',
    externalId: `ext-${id}`,
    triageDecision: 'passed',
    triageRule: 'none',
    threadKey: `t-${id}`,
    from: 'Riley <riley@acme.example>',
    to: ['me@example.com'],
    subject,
    snippet: '',
    sentAt,
    classification: 'other',
    outreachKind: null,
    mismatchReason: null,
    confidence: 0.9,
    bodySource: 'stored',
    opportunityId: 'opp-1',
    opportunityTitle: 'Staff PM',
    companyName: 'Acme',
    opportunityStage: 'applied',
    needsReview: false,
    proposedTransition: null,
    createdAt: sentAt,
  } as CommunicationView;
}

/** As the server answers an opportunity's thread: oldest first, ties by id. */
const THREAD = [
  message('a1', 'First contact', T0),
  message('b2', 'Same moment, lower id', T0 + DAY),
  message('c3', 'Same moment, higher id', T0 + DAY),
  message('d4', 'Latest reply', T0 + 2 * DAY),
];

async function subjects(): Promise<string[]> {
  const list = await screen.findByRole('list', { name: 'Linked messages' });
  return within(list)
    .getAllByRole('listitem')
    .map(
      (li) => THREAD.find((m) => li.textContent?.includes(m.subject ?? '\u0000'))?.subject ?? '?',
    );
}

function renderTab(items: CommunicationView[] = THREAD) {
  const api = mockApi({ 'GET /communications': { items, total: items.length } });
  const user = userEvent.setup();
  renderWithProviders(<CommunicationsTab opportunityId="opp-1" />);
  return { user, api };
}

describe('CommunicationsTab order (#394)', () => {
  it('shows the newest message first by default', async () => {
    renderTab();
    expect(await subjects()).toEqual([
      'Latest reply',
      'Same moment, higher id',
      'Same moment, lower id',
      'First contact',
    ]);
    expect(screen.getByRole('button', { name: 'Sorted newest first' })).toHaveTextContent('Newest');
  });

  it('one labelled control switches to oldest first and back, from the keyboard too', async () => {
    const { user } = renderTab();
    const toggle = await screen.findByRole('button', { name: 'Sorted newest first' });
    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Sorted oldest first' })).toHaveTextContent('Oldest');
    expect(await subjects()).toEqual([
      'First contact',
      'Same moment, lower id',
      'Same moment, higher id',
      'Latest reply',
    ]);
    // Back again with the keyboard.
    screen.getByRole('button', { name: 'Sorted oldest first' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Sorted newest first' })).toHaveFocus();
    expect((await subjects())[0]).toBe('Latest reply');
  });

  it('asks the server for the order it shows, so a long thread shows its newest messages', async () => {
    const { user, api } = renderTab();
    await screen.findByRole('button', { name: 'Sorted newest first' });
    const asked = () =>
      api.calls
        .filter((c) => c.method === 'GET' && c.path === '/communications')
        .map((c) => new URLSearchParams(c.search).get('order'));
    expect(asked()).toEqual(['newest']);
    await user.click(screen.getByRole('button', { name: 'Sorted newest first' }));
    await waitFor(() => expect(asked()).toEqual(['newest', 'oldest']));
  });

  it('ties on date keep one order: by id, so toggling exactly reverses the list', async () => {
    // Given out of order on purpose: the tab does not rely on the server's tie order.
    const { user } = renderTab([THREAD[2]!, THREAD[0]!, THREAD[3]!, THREAD[1]!]);
    const newest = await subjects();
    await user.click(screen.getByRole('button', { name: 'Sorted newest first' }));
    expect(await subjects()).toEqual([...newest].reverse());
    expect(newest.slice(1, 3)).toEqual(['Same moment, higher id', 'Same moment, lower id']);
  });

  it('a message without a usable date sorts as the oldest, and breaks nothing', async () => {
    const undated = message('e5', 'No date', Number.NaN);
    const { user } = renderTab([...THREAD, undated]);
    const list = await screen.findByRole('list', { name: 'Linked messages' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(5);
    expect(items.at(-1)).toHaveTextContent('No date');
    await user.click(screen.getByRole('button', { name: 'Sorted newest first' }));
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('No date');
  });

  it('starts newest first on every load', async () => {
    const first = renderTab();
    await first.user.click(await screen.findByRole('button', { name: 'Sorted newest first' }));
    expect(screen.getByRole('button', { name: 'Sorted oldest first' })).toBeInTheDocument();
    cleanup();
    renderTab();
    expect(await screen.findByRole('button', { name: 'Sorted newest first' })).toBeInTheDocument();
  });
});

// https://github.com/bgoleno/opportun/issues/422: over the server's 200 cap, the tab says how
// many it shows of how many, and shows the rest on request; switching order never shows the
// held page re-sorted as if it were the other order's.
describe('CommunicationsTab over the cap (#422)', () => {
  const COUNT = 205;
  /** Message i was sent i minutes after T0: "Message 0" is the oldest. */
  const LONG = Array.from({ length: COUNT }, (_, i) =>
    message(`m${String(i).padStart(3, '0')}`, `Message ${i}`, T0 + i * 60_000),
  );

  /** As the server answers: ordered, then the page at `offset`, with the thread's total. */
  function serve(call: ApiCall) {
    const q = new URLSearchParams(call.search);
    const oldest = [...LONG];
    const ordered = q.get('order') === 'oldest' ? oldest : oldest.reverse();
    const offset = Number(q.get('offset') ?? '0');
    const limit = Number(q.get('limit') ?? '50');
    return { items: ordered.slice(offset, offset + limit), total: COUNT };
  }

  const shown = () =>
    within(screen.getByRole('list', { name: 'Linked messages' })).getAllByRole('listitem');

  it('says it shows the newest 200 of 205, and "Show 5 more" shows the rest', async () => {
    const api = mockApi({ 'GET /communications': serve });
    const user = userEvent.setup();
    renderWithProviders(<CommunicationsTab opportunityId="opp-1" />);
    expect(await screen.findByText('Showing the newest 200 of 205 messages.')).toBeInTheDocument();
    expect(shown()).toHaveLength(200);
    expect(shown()[0]).toHaveTextContent('Message 204');
    await user.click(screen.getByRole('button', { name: 'Show 5 more' }));
    await waitFor(() => expect(shown()).toHaveLength(COUNT));
    expect(shown().at(-1)).toHaveTextContent('Message 0');
    expect(screen.queryByText(/Showing the/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Show \d+ more/ })).toBeNull();
    const offsets = api.calls
      .filter((c) => c.path === '/communications')
      .map((c) => new URLSearchParams(c.search).get('offset') ?? '0');
    expect(offsets).toEqual(['0', '200']);
  });

  it('oldest first says so: the oldest 200 of 205', async () => {
    mockApi({ 'GET /communications': serve });
    const user = userEvent.setup();
    renderWithProviders(<CommunicationsTab opportunityId="opp-1" />);
    await user.click(await screen.findByRole('button', { name: 'Sorted newest first' }));
    expect(await screen.findByText('Showing the oldest 200 of 205 messages.')).toBeInTheDocument();
    expect(shown()[0]).toHaveTextContent('Message 0');
  });

  it('while the other order loads, it says so, and never shows the held 200 re-sorted', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    mockApi({
      'GET /communications': async (call: ApiCall) => {
        if (new URLSearchParams(call.search).get('order') === 'oldest') await held;
        return serve(call);
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<CommunicationsTab opportunityId="opp-1" />);
    await screen.findByText('Showing the newest 200 of 205 messages.');
    await user.click(screen.getByRole('button', { name: 'Sorted newest first' }));
    expect(await screen.findByText('Loading the oldest messages...')).toBeInTheDocument();
    // Not the newest 200 turned round: Message 5 would lead them.
    expect(screen.queryByRole('list', { name: 'Linked messages' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sorted oldest first' })).toBeInTheDocument();
    release();
    await waitFor(() => expect(shown()[0]).toHaveTextContent('Message 0'));
    expect(screen.queryByText('Loading the oldest messages...')).toBeNull();
  });
});

describe('CommunicationsTab at or under the cap: as before (#422)', () => {
  it('no count line and no "more" button, and switching order re-sorts at once', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    mockApi({
      'GET /communications': async (call: ApiCall) => {
        if (new URLSearchParams(call.search).get('order') === 'oldest') await held;
        return { items: THREAD, total: THREAD.length };
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<CommunicationsTab opportunityId="opp-1" />);
    await screen.findByRole('list', { name: 'Linked messages' });
    expect(screen.queryByText(/Showing the/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Show \d+ more/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Sorted newest first' }));
    // The whole thread is held, so the new order is shown from it at once, with no loading line.
    expect(await subjects()).toEqual([
      'First contact',
      'Same moment, lower id',
      'Same moment, higher id',
      'Latest reply',
    ]);
    expect(screen.queryByText(/Loading the/)).toBeNull();
    release();
  });
});
