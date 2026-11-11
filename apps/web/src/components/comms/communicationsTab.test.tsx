// An opportunity's linked messages, newest first by default with a control to read them oldest
// first (https://github.com/bgoleno/opportun/issues/394). The server answers the thread oldest
// first, ties by id; the tab only reorders what it was given.
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
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
  mockApi({ 'GET /communications': { items, total: items.length } });
  const user = userEvent.setup();
  renderWithProviders(<CommunicationsTab opportunityId="opp-1" />);
  return { user };
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
