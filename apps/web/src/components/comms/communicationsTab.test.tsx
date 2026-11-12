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

/** Message i of a long thread, sent i minutes after T0: "Message 0" is the oldest. */
const nth = (i: number) =>
  message(`m${String(i).padStart(3, '0')}`, `Message ${i}`, T0 + i * 60_000);

/**
 * As the server answers: `thread` (oldest first) as it is at the time of the call, ordered,
 * then the page at `offset`, with the thread's total then.
 */
function serveFrom(thread: () => CommunicationView[]) {
  return (call: ApiCall) => {
    const q = new URLSearchParams(call.search);
    const oldest = [...thread()];
    const ordered = q.get('order') === 'oldest' ? oldest : oldest.reverse();
    const offset = Number(q.get('offset') ?? '0');
    const limit = Number(q.get('limit') ?? '50');
    return { items: ordered.slice(offset, offset + limit), total: oldest.length };
  };
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
  const LONG = Array.from({ length: COUNT }, (_, i) => nth(i));
  const serve = serveFrom(() => LONG);

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

  it('"Show N more" offers at most one page: 450 says 200, then 50', async () => {
    mockApi({
      'GET /communications': serveFrom(() => Array.from({ length: 450 }, (_, i) => nth(i))),
    });
    const user = userEvent.setup();
    renderWithProviders(<CommunicationsTab opportunityId="opp-1" />);
    expect(await screen.findByText('Showing the newest 200 of 450 messages.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show 200 more' }));
    expect(await screen.findByText('Showing the newest 400 of 450 messages.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show 50 more' }));
    await waitFor(() => expect(shown()).toHaveLength(450));
  });

  it("keeps a keyboard user's place: when the button goes, focus is on the first added message", async () => {
    mockApi({ 'GET /communications': serve });
    const user = userEvent.setup();
    renderWithProviders(<CommunicationsTab opportunityId="opp-1" />);
    (await screen.findByRole('button', { name: 'Show 5 more' })).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(shown()).toHaveLength(COUNT));
    expect(screen.getByRole('listitem', { name: 'Message 4' })).toHaveFocus();
  });

  it('leaves focus where the user moved it while the last page was on its way', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    mockApi({
      'GET /communications': async (call: ApiCall) => {
        if (new URLSearchParams(call.search).has('offset')) await held;
        return serve(call);
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<CommunicationsTab opportunityId="opp-1" />);
    (await screen.findByRole('button', { name: 'Show 5 more' })).focus();
    await user.keyboard('{Enter}');
    const toggle = screen.getByRole('button', { name: 'Sorted newest first' });
    toggle.focus();
    release();
    await waitFor(() => expect(shown()).toHaveLength(COUNT));
    expect(toggle).toHaveFocus();
  });
});

// A thread that changes while it is open (a mail sync links or unlinks a message between two
// pages): the pages are asked for by offset, so the second one starts a row early or late. The
// tab never shows one message twice, refetches the pages it holds when their totals differ,
// and never says it shows the whole thread while one is missing (#422, tl's ruling on #446).
describe('CommunicationsTab when the thread changes between pages (#422)', () => {
  const names = () =>
    within(screen.getByRole('list', { name: 'Linked messages' }))
      .getAllByRole('listitem')
      .map((li) => li.getAttribute('aria-label'));

  /** Every row name the list ever showed twice at once, checked on every change to the page. */
  function watchForRepeats() {
    const repeats = new Set<string>();
    const check = () => {
      const list = document.querySelector('ul[aria-label="Linked messages"]');
      if (!list) return;
      const seen = new Set<string>();
      for (const li of list.querySelectorAll(':scope > li')) {
        const name = li.getAttribute('aria-label') ?? '';
        if (seen.has(name)) repeats.add(name);
        seen.add(name);
      }
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    return { repeats, stop: () => observer.disconnect() };
  }

  it('a message linked between the pages: 206 different messages, the new one first', async () => {
    let thread = Array.from({ length: 205 }, (_, i) => nth(i));
    const api = mockApi({ 'GET /communications': serveFrom(() => thread) });
    const user = userEvent.setup();
    const watch = watchForRepeats();
    renderWithProviders(<CommunicationsTab opportunityId="opp-1" />);
    expect(await screen.findByText('Showing the newest 200 of 205 messages.')).toBeInTheDocument();
    // Linked from elsewhere: the page at offset 200 now answers a total of 206 and begins with
    // Message 5, the last row of the first page.
    thread = [...thread, nth(205)];
    await user.click(screen.getByRole('button', { name: 'Show 5 more' }));
    await waitFor(() => expect(names()).toHaveLength(206));
    await waitFor(() => expect(names()[0]).toBe('Message 205'));
    watch.stop();
    expect(new Set(names()).size).toBe(206);
    expect(names().at(-1)).toBe('Message 0');
    expect([...watch.repeats]).toEqual([]);
    expect(screen.queryByText(/Showing the/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Show \d+ more/ })).toBeNull();
    // The held pages were asked for again, from the start: 0, 200, then 0 and 200.
    const offsets = api.calls
      .filter((c) => c.path === '/communications')
      .map((c) => new URLSearchParams(c.search).get('offset') ?? '0');
    expect(offsets).toEqual(['0', '200', '0', '200']);
  });

  it('a message unlinked between the pages: none skipped', async () => {
    let thread = Array.from({ length: 205 }, (_, i) => nth(i));
    mockApi({ 'GET /communications': serveFrom(() => thread) });
    const user = userEvent.setup();
    renderWithProviders(<CommunicationsTab opportunityId="opp-1" />);
    expect(await screen.findByText('Showing the newest 200 of 205 messages.')).toBeInTheDocument();
    // Message 100 is unlinked: the page at offset 200 now starts at Message 3, a row late, so
    // Message 4 would be skipped.
    thread = thread.filter((m) => m.subject !== 'Message 100');
    await user.click(screen.getByRole('button', { name: 'Show 5 more' }));
    await waitFor(() => expect(names()).toContain('Message 4'));
    await waitFor(() => expect(names()).not.toContain('Message 100'));
    expect(names()).toHaveLength(204);
    expect(new Set(names()).size).toBe(204);
    expect(screen.queryByText(/Showing the/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Show \d+ more/ })).toBeNull();
  });

  // A thread that keeps changing must not make the tab ask again and again: one refetch for
  // each set of totals it sees (tl on #446).
  it('a thread whose pages keep disagreeing is fetched again once, not again and again', async () => {
    const thread = Array.from({ length: 205 }, (_, i) => nth(i));
    const serve = serveFrom(() => thread);
    const api = mockApi({
      // Page 2 always answers a total one higher than page 1's, as if a message were linked
      // between every pair of requests. Each answer takes a moment, as a real server's does, so
      // the tab sees each refetch start and finish.
      'GET /communications': async (call: ApiCall) => {
        await new Promise((r) => setTimeout(r, 10));
        const page = serve(call);
        return new URLSearchParams(call.search).has('offset')
          ? { ...page, total: page.total + 1 }
          : page;
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<CommunicationsTab opportunityId="opp-1" />);
    await screen.findByText('Showing the newest 200 of 205 messages.');
    await user.click(screen.getByRole('button', { name: 'Show 5 more' }));
    const offsets = () =>
      api.calls
        .filter((c) => c.path === '/communications')
        .map((c) => new URLSearchParams(c.search).get('offset') ?? '0');
    await waitFor(() => expect(offsets()).toEqual(['0', '200', '0', '200']));
    // Settled: no fifth request follows.
    await new Promise((r) => setTimeout(r, 200));
    expect(offsets()).toEqual(['0', '200', '0', '200']);
  });

  it('while a missing message is on its way, the line says one is missing', async () => {
    let thread = Array.from({ length: 205 }, (_, i) => nth(i));
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const serve = serveFrom(() => thread);
    let calls = 0;
    mockApi({
      'GET /communications': async (call: ApiCall) => {
        calls += 1;
        // The refetch's first page is held back, so the tab is seen between the two.
        if (calls === 3) await held;
        return serve(call);
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<CommunicationsTab opportunityId="opp-1" />);
    await screen.findByText('Showing the newest 200 of 205 messages.');
    thread = [...thread, nth(205)];
    await user.click(screen.getByRole('button', { name: 'Show 5 more' }));
    // 205 different messages held (Message 5 once), of the newest total, 206.
    expect(await screen.findByText('Showing the newest 205 of 206 messages.')).toBeInTheDocument();
    expect(new Set(names()).size).toBe(names().length);
    release();
    await waitFor(() => expect(names()[0]).toBe('Message 205'));
    expect(screen.queryByText(/Showing the/)).toBeNull();
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
