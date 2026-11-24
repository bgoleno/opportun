// The review queue reads its list again when the user comes back to the page, and keeps their
// place in it (https://github.com/bgoleno/opportun/issues/968; tl's design, section 1, on
// https://github.com/bgoleno/opportun/issues/967). A card captured with the extension, or decided
// in another tab, is gone from the list the server answers; nothing on the page was told.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { qk } from '@/lib/opportunities';
import { mockApi, renderWithProviders, toastRegion, type ApiCall } from '@/test/render';
import { discoveryKeys, type DiscoveryResult } from './api';
import { groupResults, rowKey } from './groupResults';
import { selectionAfterRead } from './queueSelection';
import { ReviewQueue } from './ReviewQueue';

const NOW = Date.now();

function result(id: string, over: Partial<DiscoveryResult> = {}): DiscoveryResult {
  return {
    id,
    runId: 'run-1',
    sourceId: 'src-1',
    sourceKind: 'alert_email',
    roleTargetId: null,
    posting: { company: 'Initech', title: `Role ${id}`, postingUrl: null, location: null },
    dedupeKey: `initech|role ${id}|`,
    aiScore: 80,
    aiRationale: null,
    rankSkipReason: null,
    rankDeferredAt: null,
    rankBatchSentAt: null,
    prefilterOutcome: null,
    prefilterRule: null,
    resolution: 'needs_capture',
    resolvedSourceRef: null,
    disposition: 'pending',
    opportunityId: null,
    sourceMailChannel: null,
    sourceMailExternalId: null,
    dismissReason: null,
    dismissNote: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

const [A, B, C, D] = [result('A'), result('B'), result('C'), result('D')] as const;

/** Two locations of one role: one card while both are pending. */
const PAIR_1 = result('P1', {
  dedupeKey: 'globex|analyst|austin',
  posting: { company: 'Globex', title: 'Analyst', postingUrl: null, location: 'Austin' },
});
const PAIR_2 = result('P2', {
  dedupeKey: 'globex|analyst|boston',
  posting: { company: 'Globex', title: 'Analyst', postingUrl: null, location: 'Boston' },
});

const isQuestion = (c: ApiCall) => new URLSearchParams(c.search).get('disposition') === 'accepted';

/**
 * The queue on a server whose list the test changes. `more` adds results past the first page,
 * `accepted` is how many results have been accepted: what the page asks about (useQueueWatch).
 */
function queue(initial: DiscoveryResult[], routes: Record<string, unknown> = {}) {
  const server = {
    items: initial,
    more: 0,
    accepted: 0,
    down: false,
    /** Held: the question is answered from what is there after, the list from before. */
    holdQuestion: undefined as Promise<void> | undefined,
    holdList: undefined as Promise<void> | undefined,
  };
  const { calls } = mockApi({
    'GET /discovery/results': async (call: ApiCall) => {
      const q = new URLSearchParams(call.search);
      if (isQuestion(call)) {
        if (server.holdQuestion !== undefined) await server.holdQuestion;
        if (server.down) return { status: 503, body: { error: { code: 'unavailable' } } };
        const last = result('last', {
          disposition: 'accepted',
          opportunityId: 'o-1',
          updatedAt: server.accepted,
        });
        return { items: server.accepted === 0 ? [] : [last], total: server.accepted };
      }
      const offset = Number(q.get('offset') ?? 0);
      const total = server.items.length + server.more;
      if (offset > 0) return { items: [], total };
      const limited = q.has('offset')
        ? [
            ...server.items,
            ...Array.from({ length: server.more }, (_, i) => result(`later-${String(i)}`)),
          ]
        : server.items;
      const answer = { items: limited, total };
      if (server.holdList !== undefined) await server.holdList;
      return answer;
    },
    ...routes,
  });
  const view = renderWithProviders(<ReviewQueue />);
  const gets = () => calls.filter((c) => c.method === 'GET' && c.path === '/discovery/results');
  const reads = () => gets().filter((c) => !isQuestion(c)).length;
  const questions = () => gets().filter(isQuestion).length;
  return { server, calls, reads, questions, ...view };
}

const row = (name: string) => screen.getByRole('listitem', { name: `Role ${name} at Initech` });
const noRow = (name: string) =>
  expect(screen.queryByRole('listitem', { name: `Role ${name} at Initech` })).toBeNull();
const selected = () =>
  screen
    .queryAllByRole('listitem')
    .filter((n) => n.getAttribute('aria-current') === 'true')
    .map((n) => n.getAttribute('aria-label'));

const visible = () => fireEvent(document, new Event('visibilitychange'));
const focused = () => fireEvent(window, new Event('focus'));

/** The clock the hook tells two returns apart by; each test's returns are far apart unless it says. */
let clock = 0;
beforeEach(() => {
  clock = 1_000_000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Comes back to the page after the server's list changed, and waits for the read. */
async function comeBack(q: { reads: () => number }) {
  const before = q.reads();
  clock += 60_000;
  visible();
  await waitFor(() => expect(q.reads()).toBe(before + 1));
}

describe('coming back to the Discovery page', () => {
  it.each([
    ['the tab becomes visible', [visible]],
    ['the window gets the focus (a posting was open in another window)', [focused]],
    ['both, as a browser fires them for one return', [visible, focused]],
    ['both, the focus first', [focused, visible]],
  ])('%s: one read, and the captured card is gone', async (_what, events) => {
    const q = queue([A, B]);
    expect(await screen.findByText('2 results to review.')).toBeInTheDocument();
    expect(q.reads()).toBe(1);

    q.server.items = [B];
    for (const fire of events) {
      fire();
      clock += 200;
    }

    expect(await screen.findByText('1 result to review.')).toBeInTheDocument();
    noRow('A');
    expect(row('B')).toBeInTheDocument();
    // Settled: no second read is on its way.
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(q.reads()).toBe(2);
    expect(q.questions()).toBe(1);
  });

  it('reads again on the next return, and not while the page is hidden', async () => {
    const q = queue([A, B]);
    await screen.findByText('2 results to review.');
    await comeBack(q);
    await comeBack(q);
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const before = q.reads();
    clock += 60_000;
    visible();
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(q.reads()).toBe(before);
    state.mockRestore();
  });

  it('the last card: an empty queue, and no error', async () => {
    const q = queue([A]);
    const user = userEvent.setup();
    await screen.findByText('1 result to review.');
    await user.keyboard('j');
    q.server.items = [];
    await comeBack(q);
    expect(await screen.findByText(/^Nothing to review\./)).toBeInTheDocument();
    expect(screen.getByText('0 results to review.')).toBeInTheDocument();
    expect(selected()).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
    // And the keys have nothing to act on.
    await user.keyboard('ji');
    expect(q.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('stops when the page is left', async () => {
    const q = queue([A]);
    await screen.findByText('1 result to review.');
    q.queryClient.setQueryData(discoveryKeys.decided('accepted'), { items: [], total: 0 });
    q.unmount();
    visible();
    clock += 60_000;
    focused();
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(q.queryClient.getQueryState(discoveryKeys.decided('accepted'))?.isInvalidated).toBe(
      false,
    );
  });

  it('marks the Decided lists and the pipeline as read before it', async () => {
    const q = queue([A]);
    await screen.findByText('1 result to review.');
    q.queryClient.setQueryData(discoveryKeys.decided('accepted'), { items: [], total: 0 });
    q.queryClient.setQueryData([...qk.opportunities, 'list'], []);
    await comeBack(q);
    expect(q.queryClient.getQueryState(discoveryKeys.decided('accepted'))?.isInvalidated).toBe(
      true,
    );
    expect(q.queryClient.getQueryState([...qk.opportunities, 'list'])?.isInvalidated).toBe(true);
  });

  it.each([
    ['an accept', 'single'],
    ['a bulk accept', 'bulk'],
  ])('does not read while %s is in flight: that reads when it settles', async (_what, kind) => {
    let answer!: () => void;
    const gate = new Promise<void>((r) => (answer = r));
    const q = queue([A, B], {
      'POST /discovery/results/A/accept': async () => {
        await gate;
        return { ...A, disposition: 'accepted', opportunityId: 'o-1' };
      },
      'POST /discovery/results/bulk-accept': async () => {
        await gate;
        return { results: [{ id: 'A', outcome: 'accepted' }] };
      },
    });
    const user = userEvent.setup();
    await screen.findByText('2 results to review.');
    if (kind === 'single') {
      await user.click(screen.getByRole('button', { name: 'Accept Role A at Initech' }));
    } else {
      await user.click(screen.getByRole('checkbox', { name: 'Select Role A at Initech' }));
      await user.click(screen.getByRole('button', { name: 'Accept' }));
      await user.click(screen.getByRole('button', { name: 'Accept 1' }));
    }
    await waitFor(() => expect(q.calls.some((c) => c.method === 'POST')).toBe(true));
    clock += 60_000;
    visible();
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(q.reads()).toBe(1);
    q.server.items = [B];
    answer();
    expect(await screen.findByText('1 result to review.')).toBeInTheDocument();
    expect(q.reads()).toBe(2);
  });
});

// A capture that finishes after the user is back, or beside a page that was never left (tl's ruling
// on https://github.com/bgoleno/opportun/issues/967#issuecomment-7119770290): the page asks whether
// anything was accepted, for a while, and reads its list when something was.
describe('while a capture may still be finishing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const pass = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));
  /** Captures `gone` on the server: accepted, and off the list. */
  function captured(q: ReturnType<typeof queue>, gone: DiscoveryResult) {
    q.server.items = q.server.items.filter((r) => r.id !== gone.id);
    q.server.accepted += 1;
  }

  it('a card captured after the return leaves by itself within 5 s', async () => {
    const q = queue([A, B]);
    await screen.findByText('2 results to review.');
    visible();
    await waitFor(() => expect(q.reads()).toBe(2));
    expect(q.questions()).toBe(1);

    captured(q, A);
    await pass(5000);
    noRow('A');
    expect(screen.getByText('1 result to review.')).toBeInTheDocument();
    expect(q.reads()).toBe(3);
  });

  it('the first question is asked before the list is read: an accept between the two is seen', async () => {
    const q = queue([A, B]);
    await screen.findByText('2 results to review.');
    visible();
    await waitFor(() => expect(q.reads()).toBe(2));
    const order = q.calls
      .filter((c) => c.path === '/discovery/results')
      .map((c) => (isQuestion(c) ? 'question' : 'list'));
    expect(order).toEqual(['list', 'question', 'list']);
  });

  it('reads the list only when something was accepted', async () => {
    const q = queue([A, B]);
    await screen.findByText('2 results to review.');
    visible();
    await waitFor(() => expect(q.reads()).toBe(2));
    await pass(20_000);
    expect(q.questions()).toBeGreaterThanOrEqual(6);
    expect(q.reads()).toBe(2);
  });

  it('stops a minute after the return', async () => {
    const q = queue([A, B]);
    await screen.findByText('2 results to review.');
    visible();
    await pass(58_000);
    const asked = q.questions();
    expect(asked).toBeGreaterThanOrEqual(18);
    await pass(8_000);
    const last = q.questions();
    captured(q, A);
    await pass(120_000);
    expect(q.questions()).toBe(last);
    expect(q.reads()).toBe(2);
  });

  it('asks nothing before a return and without a posting opened', async () => {
    const q = queue([A, B]);
    await screen.findByText('2 results to review.');
    await pass(60_000);
    expect(q.questions()).toBe(0);
    expect(q.reads()).toBe(1);
  });

  const linked = result('L', {
    posting: {
      company: 'Initech',
      title: 'Role L',
      postingUrl: 'https://www.linkedin.com/jobs/view/1000000001/',
      location: null,
    },
  });
  const pair = [PAIR_1, PAIR_2].map((r) => ({
    ...r,
    posting: { ...r.posting, postingUrl: `https://www.linkedin.com/jobs/view/${r.id}/` },
  }));

  it.each([
    [
      'the Posting button',
      [linked],
      () =>
        fireEvent.click(screen.getByRole('link', { name: 'Open posting for Role L at Initech' })),
    ],
    [
      'the Posting button, with the middle mouse button',
      [linked],
      () =>
        fireEvent(
          screen.getByRole('link', { name: 'Open posting for Role L at Initech' }),
          new MouseEvent('auxclick', { bubbles: true, button: 1 }),
        ),
    ],
    [
      'the p key',
      [linked],
      () => {
        vi.stubGlobal('open', vi.fn());
        fireEvent.keyDown(document, { key: 'j' });
        fireEvent.keyDown(document, { key: 'p' });
      },
    ],
    [
      'the detail dialog',
      [linked],
      async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Role L' }));
        fireEvent.click(await screen.findByRole('link', { name: 'Open the posting' }));
      },
    ],
    [
      'a location of a card that has several',
      pair,
      () => fireEvent.click(screen.getByRole('link', { name: 'Boston' })),
    ],
  ])(
    'for ten minutes after a posting is opened from %s, with nobody leaving the page',
    async (_what, items, open) => {
      const q = queue([...items, B]);
      await screen.findByText(`${String(items.length + 1)} results to review.`);
      await open();
      await pass(590_000);
      expect(q.questions()).toBeGreaterThanOrEqual(150);
      const reads = q.reads();
      captured(q, items[0]!);
      await pass(5000);
      expect(q.reads()).toBe(reads + 1);
      expect(
        screen.getByText(
          `${String(items.length)} result${items.length === 1 ? '' : 's'} to review.`,
        ),
      ).toBeInTheDocument();
      await pass(10_000);
      const last = q.questions();
      await pass(120_000);
      expect(q.questions()).toBe(last);
    },
  );

  it('a capture made before the posting was opened is seen too: the first answer reads the list', async () => {
    const q = queue([linked, B]);
    await screen.findByText('2 results to review.');
    captured(q, linked);
    fireEvent.click(screen.getByRole('link', { name: 'Open posting for Role L at Initech' }));
    await pass(5000);
    expect(screen.getByText('1 result to review.')).toBeInTheDocument();
  });

  it('asks nothing while the page is hidden, and goes on when it is back', async () => {
    const q = queue([linked, B]);
    await screen.findByText('2 results to review.');
    fireEvent.click(screen.getByRole('link', { name: 'Open posting for Role L at Initech' }));
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    visible();
    await pass(30_000);
    expect(q.questions()).toBe(0);
    state.mockRestore();
    visible();
    await pass(30_000);
    expect(q.questions()).toBeGreaterThanOrEqual(9);
    // The return's minute does not cut the posting's ten short.
    await pass(300_000);
    const asked = q.questions();
    await pass(30_000);
    expect(q.questions()).toBeGreaterThan(asked);
  });

  it('a question answered while a decision is in flight does not count as seen', async () => {
    const gate = () => {
      let open!: () => void;
      const wait = new Promise<void>((r) => (open = r));
      return { open, wait };
    };
    const q = queue([A, B, C], {
      'POST /discovery/results/A/accept': { ...A, disposition: 'accepted', opportunityId: 'o-1' },
    });
    await screen.findByText('3 results to review.');
    visible();
    await waitFor(() => expect(q.reads()).toBe(2));
    // A question is on its way; Accept reads the list when it settles, and that read is answered
    // without B's capture, which commits before the question is.
    const question = gate();
    const list = gate();
    q.server.holdQuestion = question.wait;
    await pass(3000);
    q.server.holdList = list.wait;
    q.server.items = [B, C];
    fireEvent.click(screen.getByRole('button', { name: 'Accept Role A at Initech' }));
    await waitFor(() => expect(q.reads()).toBe(3));
    captured(q, B);
    q.server.holdQuestion = undefined;
    question.open();
    await pass(100);
    q.server.holdList = undefined;
    list.open();
    await pass(5000);
    expect(screen.getByText('1 result to review.')).toBeInTheDocument();
  });

  it('asks nothing while a decision is in flight, and sees what was accepted meanwhile', async () => {
    let answer!: () => void;
    const gate = new Promise<void>((r) => (answer = r));
    const q = queue([A, B, C], {
      'POST /discovery/results/A/dismiss': async () => {
        await gate;
        return { ...A, disposition: 'dismissed' };
      },
    });
    await screen.findByText('3 results to review.');
    visible();
    await waitFor(() => expect(q.reads()).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Role A at Initech' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dismiss result' });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'stale' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(q.calls.some((c) => c.method === 'POST')).toBe(true));
    const asked = q.questions();
    await pass(15_000);
    expect(q.questions()).toBe(asked);
    captured(q, B);
    q.server.items = q.server.items.filter((r) => r.id !== 'A');
    answer();
    await pass(5000);
    expect(screen.getByText('1 result to review.')).toBeInTheDocument();
  });

  it('a failed question is silent and the next one goes on', async () => {
    const q = queue([A, B]);
    await screen.findByText('2 results to review.');
    visible();
    await waitFor(() => expect(q.reads()).toBe(2));
    q.server.down = true;
    await pass(7000);
    expect(screen.queryByRole('alert')).toBeNull();
    captured(q, A);
    q.server.down = false;
    await pass(5000);
    expect(screen.getByText('1 result to review.')).toBeInTheDocument();
  });

  it('reads the list on a return even when the question fails', async () => {
    const q = queue([A, B]);
    await screen.findByText('2 results to review.');
    q.server.down = true;
    captured(q, A);
    visible();
    await pass(500);
    expect(screen.getByText('1 result to review.')).toBeInTheDocument();
  });

  it('stops when the page is left', async () => {
    const q = queue([A, B]);
    await screen.findByText('2 results to review.');
    visible();
    await waitFor(() => expect(q.reads()).toBe(2));
    q.unmount();
    const asked = q.questions();
    await pass(30_000);
    expect(q.questions()).toBe(asked);
  });
});

describe('the selected card, when a read takes it away', () => {
  const ids = (...all: DiscoveryResult[]) => groupResults(all);
  const PAIR_KEY = rowKey(ids(PAIR_1, PAIR_2)[0]!);

  it.each([
    ['still there: itself', ids(A, B, C), ids(C, B, A), 'B', 'B'],
    ['the next one', ids(A, B, C), ids(A, C), 'B', 'C'],
    ['the next still there, past others that went too', ids(A, B, C, D), ids(A, D), 'B', 'D'],
    ['the one before, when none after is left', ids(A, B, C), ids(A), 'C', 'A'],
    ['the nearest before', ids(A, B, C), ids(A, B), 'C', 'B'],
    ['none', ids(A, B), ids(), 'A', null],
    ['not a row before the read: left as it is', ids(A), ids(B), 'X', 'X'],
    [
      'a pair that lost one, now a plain row',
      ids(A, PAIR_1, PAIR_2),
      ids(A, PAIR_2),
      PAIR_KEY,
      'P2',
    ],
    [
      'a plain row that became one of a pair',
      ids(A, PAIR_2),
      ids(A, PAIR_1, PAIR_2),
      'P2',
      PAIR_KEY,
    ],
    ['next to a pair that lost one', ids(A, PAIR_1, PAIR_2), ids(PAIR_2), 'A', 'P2'],
  ] as const)('%s', (_what, prev, next, from, to) => {
    expect(selectionAfterRead(prev, next, from)).toBe(to);
  });

  it('is replaced by the next one, and the keyboard goes with it without scrolling', async () => {
    const q = queue([A, B, C]);
    const user = userEvent.setup();
    await screen.findByText('3 results to review.');
    await user.keyboard('jj');
    expect(row('B')).toHaveFocus();

    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    q.server.items = [A, C];
    await comeBack(q);
    await waitFor(() => expect(row('C')).toHaveFocus());
    expect(selected()).toEqual(['Role C at Initech']);
    expect(focus.mock.calls).toEqual([[{ preventScroll: true }]]);
    // And the keys go on from there.
    await user.keyboard('k');
    expect(row('A')).toHaveFocus();
  });

  it('follows the keyboard from a button inside the card too', async () => {
    const q = queue([A, B]);
    await screen.findByText('2 results to review.');
    act(() => screen.getByRole('button', { name: 'Dismiss Role A at Initech' }).focus());
    q.server.items = [B];
    await comeBack(q);
    await waitFor(() => expect(row('B')).toHaveFocus());
  });

  it('leaves the keyboard alone when it was somewhere else', async () => {
    const q = queue([A, B]);
    const user = userEvent.setup();
    await screen.findByText('2 results to review.');
    await user.keyboard('j');
    const sort = screen.getByLabelText('Sort by');
    act(() => sort.focus());
    q.server.items = [B];
    await comeBack(q);
    await waitFor(() => expect(selected()).toEqual(['Role B at Initech']));
    expect(sort).toHaveFocus();
  });

  it('a card that loses one of its two locations keeps the selection and the keyboard', async () => {
    const q = queue([A, PAIR_1, PAIR_2]);
    const user = userEvent.setup();
    await screen.findByText('3 results to review.');
    await user.keyboard('jj');
    expect(screen.getByRole('listitem', { name: 'Analyst at Globex, 2 locations' })).toHaveFocus();
    q.server.items = [A, PAIR_2];
    await comeBack(q);
    const single = await screen.findByRole('listitem', { name: 'Analyst at Globex' });
    await waitFor(() => expect(single).toHaveFocus());
    expect(selected()).toEqual(['Analyst at Globex']);
  });

  it('is not replaced by a change of order: the other order is another list', async () => {
    const q = queue([A, B]);
    const user = userEvent.setup();
    await screen.findByText('2 results to review.');
    await user.keyboard('j');
    q.server.items = [B, C];
    await user.selectOptions(screen.getByLabelText('Sort by'), 'Date discovered');
    await screen.findByRole('listitem', { name: 'Role C at Initech' });
    expect(selected()).toEqual([]);
  });

  it('nor by a change back to an order already loaded', async () => {
    const q = queue([A, B]);
    const user = userEvent.setup();
    await screen.findByText('2 results to review.');
    q.server.items = [B, C];
    const sort = screen.getByLabelText('Sort by');
    await user.selectOptions(sort, 'Date discovered');
    await screen.findByRole('listitem', { name: 'Role C at Initech' });
    act(() => row('C').focus());
    expect(selected()).toEqual(['Role C at Initech']);
    await user.selectOptions(sort, 'Relevance');
    await screen.findByRole('listitem', { name: 'Role A at Initech' });
    expect(selected()).toEqual([]);
  });

  it('nothing is selected by a read when nothing was', async () => {
    const q = queue([A, B]);
    await screen.findByText('2 results to review.');
    q.server.items = [B];
    await comeBack(q);
    await screen.findByText('1 result to review.');
    expect(selected()).toEqual([]);
  });
});

describe('checked cards, when a read changes the list', () => {
  const checkbox = (name: string) =>
    screen.getByRole('checkbox', { name: `Select Role ${name} at Initech` });

  it('only those that left the list are unchecked', async () => {
    const q = queue([A, B, C]);
    const user = userEvent.setup();
    await screen.findByText('3 results to review.');
    await user.click(checkbox('A'));
    await user.click(checkbox('B'));
    q.server.items = [D, B, C];
    await comeBack(q);
    expect(await screen.findByText('1 selected')).toBeInTheDocument();
    expect(checkbox('B')).toBeChecked();
    expect(checkbox('C')).not.toBeChecked();
  });

  it('"Select all matching" keeps the ones this page never loaded', async () => {
    const q = queue([A, B, C], {
      'POST /discovery/results/bulk-dismiss': (call: ApiCall) => ({
        results: (call.body as { ids: string[] }).ids.map((id) => ({ id, outcome: 'dismissed' })),
      }),
    });
    const user = userEvent.setup();
    await screen.findByText('3 results to review.');
    q.server.more = 40;
    await comeBack(q);
    await user.click(await screen.findByRole('button', { name: 'Select all 43 matching' }));
    expect(await screen.findByText('43 selected')).toBeInTheDocument();

    q.server.items = [B, C];
    await comeBack(q);
    expect(await screen.findByText('42 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    await user.click(screen.getByRole('button', { name: 'Dismiss 42' }));
    await waitFor(() => expect(q.calls.some((c) => c.path.endsWith('bulk-dismiss'))).toBe(true));
    const sent = q.calls.find((c) => c.path.endsWith('bulk-dismiss'))?.body as { ids: string[] };
    expect(sent.ids).not.toContain('A');
    expect(sent.ids).toContain('later-39');
  });

  it.each([
    ['Accept', 'Accept 1 results?'],
    ['Dismiss', 'Dismiss 1 results'],
  ])(
    'the bulk %s dialog closes when nothing is left to act on, and does not come back',
    async (button, title) => {
      const q = queue([A, B]);
      const user = userEvent.setup();
      await screen.findByText('2 results to review.');
      await user.click(checkbox('A'));
      await user.click(screen.getByRole('button', { name: button }));
      expect(await screen.findByRole('dialog', { name: title })).toBeInTheDocument();
      if (button === 'Dismiss') await user.type(screen.getByLabelText('Note (optional)'), 'of A');
      q.server.items = [B];
      await comeBack(q);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await user.click(checkbox('B'));
      expect(screen.queryByRole('dialog')).toBeNull();
      if (button === 'Dismiss') {
        await user.click(screen.getByRole('button', { name: button }));
        expect(await screen.findByLabelText('Note (optional)')).toHaveValue('');
      }
    },
  );

  it('a Shift range starts at the card last checked, wherever a read has moved it', async () => {
    const q = queue([A, B, C, D]);
    const user = userEvent.setup();
    await screen.findByText('4 results to review.');
    await user.click(checkbox('B'));
    // B was second and is now third: the range to D is B and D, and not C before it.
    q.server.items = [C, A, B, D];
    await comeBack(q);
    await waitFor(() =>
      expect(screen.getAllByRole('listitem')[0]).toHaveAccessibleName('Role C at Initech'),
    );
    await user.keyboard('{Shift>}');
    await user.click(checkbox('D'));
    await user.keyboard('{/Shift}');
    expect(await screen.findByText('2 selected')).toBeInTheDocument();
    expect(checkbox('A')).not.toBeChecked();
    expect(checkbox('C')).not.toBeChecked();
  });

  it('a Shift range whose start has left is a plain check', async () => {
    const q = queue([A, B, C]);
    const user = userEvent.setup();
    await screen.findByText('3 results to review.');
    await user.click(checkbox('A'));
    q.server.items = [B, C];
    await comeBack(q);
    await waitFor(() => noRow('A'));
    await user.keyboard('{Shift>}');
    await user.click(checkbox('C'));
    await user.keyboard('{/Shift}');
    expect(await screen.findByText('1 selected')).toBeInTheDocument();
    expect(checkbox('C')).toBeChecked();
  });

  it('Shift+J goes on from the cursor when its start has left', async () => {
    const q = queue([A, B, C, D]);
    const user = userEvent.setup();
    await screen.findByText('4 results to review.');
    await user.click(checkbox('D'));
    await user.click(checkbox('D'));
    q.server.items = [A, B, C];
    await comeBack(q);
    await waitFor(() => noRow('D'));
    act(() => row('A').focus());
    await user.keyboard('{Shift>}J{/Shift}');
    expect(checkbox('A')).toBeChecked();
    expect(checkbox('B')).toBeChecked();
    expect(checkbox('C')).not.toBeChecked();
  });
});

describe('an open dialog, when a read takes its card away', () => {
  it('the detail dialog closes', async () => {
    const q = queue([A, B]);
    const user = userEvent.setup();
    await screen.findByText('2 results to review.');
    await user.click(screen.getByRole('button', { name: 'Role A' }));
    expect(await screen.findByRole('dialog', { name: 'Role A' })).toBeInTheDocument();
    q.server.items = [B];
    await comeBack(q);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('the detail dialog of a card still there stays', async () => {
    const q = queue([A, B]);
    const user = userEvent.setup();
    await screen.findByText('2 results to review.');
    await user.click(screen.getByRole('button', { name: 'Role A' }));
    await screen.findByRole('dialog', { name: 'Role A' });
    q.server.items = [C, A];
    await comeBack(q);
    await waitFor(() => expect(q.queryClient.isFetching()).toBe(0));
    expect(screen.getByRole('dialog', { name: 'Role A' })).toBeInTheDocument();
  });

  it('the dismiss dialog stays with its note, and the answer says what happened', async () => {
    const q = queue([A, B], {
      'POST /discovery/results/A/dismiss': () => ({
        status: 409,
        body: {
          error: { code: 'already_decided', disposition: 'accepted', existingId: 'o-9' },
        },
      }),
    });
    const user = userEvent.setup();
    await screen.findByText('2 results to review.');
    await user.click(screen.getByRole('button', { name: 'Dismiss Role A at Initech' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dismiss result' });
    await user.selectOptions(within(dialog).getByLabelText('Reason'), 'stale');
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'Too late');
    q.server.items = [B];
    await comeBack(q);
    expect(within(dialog).getByLabelText('Note (optional)')).toHaveValue('Too late');
    await user.click(within(dialog).getByRole('button', { name: 'Dismiss' }));
    expect(
      await toastRegion().findByText('Not dismissed: already in your pipeline'),
    ).toBeInTheDocument();
  });

  it('the capture dialog stays with the text pasted into it', async () => {
    const q = queue([A, B]);
    const user = userEvent.setup();
    await screen.findByText('2 results to review.');
    await user.click(screen.getByRole('button', { name: 'Role A' }));
    await user.click(await screen.findByRole('button', { name: 'Capture description' }));
    const dialog = await screen.findByRole('dialog', { name: 'Capture description' });
    await user.click(within(dialog).getByLabelText('Pasted text'));
    await user.type(within(dialog).getByLabelText('Posting description'), 'The whole posting');
    q.server.items = [B];
    await comeBack(q);
    await waitFor(() => noRow('A'));
    expect(within(dialog).getByLabelText('Posting description')).toHaveValue('The whole posting');
  });
});
