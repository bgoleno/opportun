import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { formatDateTime } from '@/lib/opportunities';
import { mockApi, renderWithProviders, toastRegion, type ApiCall } from '@/test/render';
import type { CommunicationView } from './api';
import { Inbox } from './Inbox';
import { InboxRow } from './InboxRow';

const NOW = Date.now();

const BASE: CommunicationView = {
  id: 'c1',
  channel: 'gmail',
  externalId: 'ext-c1',
  triageDecision: 'passed',
  triageRule: 'none',
  threadKey: 't1',
  from: 'Riley <riley@acme.example>',
  to: ['me@example.com'],
  subject: 'Your application at Acme',
  snippet: 'Thank you for your interest...',
  sentAt: NOW - 60_000,
  classification: 'rejection',
  outreachKind: null,
  mismatchReason: null,
  confidence: 0.9,
  bodySource: 'stored',
  opportunityId: 'opp-1',
  opportunityTitle: 'Staff PM',
  companyName: 'Acme',
  opportunityStage: 'applied',
  needsReview: false,
  proposedTransition: 'closed',
  createdAt: NOW,
};

const posts = (calls: ApiCall[], path: string) =>
  calls.filter((c) => c.method === 'POST' && c.path === path);

describe('InboxRow', () => {
  it('shows the proposed stage and accepting calls the accept-transition endpoint', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'POST /communications/c1/accept-transition': {
        communication: { ...BASE, proposedTransition: null },
        opportunityId: 'opp-1',
        stage: 'closed',
      },
    });
    renderWithProviders(
      <ul>
        <InboxRow comm={BASE} mode="linked" />
      </ul>,
    );
    const row = await screen.findByRole('listitem', { name: 'Your application at Acme' });
    expect(within(row).getByText('Suggested stage')).toBeInTheDocument();
    expect(
      within(row).getByText('Closed', { selector: '[data-slot="badge"]' }),
    ).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Move to Closed' }));
    await waitFor(() =>
      expect(posts(calls, '/communications/c1/accept-transition')).toEqual([
        {
          method: 'POST',
          path: '/communications/c1/accept-transition',
          search: '',
          body: {},
        },
      ]),
    );
    expect(await screen.findByText('Moved to Closed')).toBeInTheDocument();
  });

  // #397: a refusal from the server names what is allowed, not its raw stage ids.
  it('a refused proposal says which stages the opportunity can move to', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /communications/c1/accept-transition': () => ({
        status: 422,
        body: {
          error: {
            code: 'invalid_transition',
            message: 'Invalid stage transition closed -> closed',
            from: 'closed',
            to: 'closed',
          },
        },
      }),
    });
    renderWithProviders(
      <ul>
        <InboxRow comm={BASE} mode="linked" />
      </ul>,
    );
    const row = await screen.findByRole('listitem', { name: 'Your application at Acme' });
    await user.click(within(row).getByRole('button', { name: 'Move to Closed' }));
    expect(await screen.findByText('Closed can move to Dismissed.')).toBeInTheDocument();
    expect(screen.queryByText(/Invalid stage transition/)).toBeNull();
  });

  it('does not offer a proposal the opportunity already reached by another route', async () => {
    // issue #143: the server already suppresses this (proposedTransition comes back null), but
    // a row already sitting in the client's cache from before a refetch should not keep
    // offering the no-op either.
    mockApi({});
    renderWithProviders(
      <ul>
        <InboxRow
          comm={{ ...BASE, opportunityStage: 'in_process', proposedTransition: 'in_process' }}
          mode="linked"
        />
      </ul>,
    );
    const row = await screen.findByRole('listitem', { name: 'Your application at Acme' });
    expect(within(row).queryByText('Suggested stage')).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /^Move to/ })).not.toBeInTheDocument();
    expect(
      within(row).getByText(/once suggested moving to in process.*already there/i),
    ).toBeInTheDocument();
  });

  it('on a closed opportunity asks to reopen and only then sends reopen', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'POST /communications/c1/accept-transition': {
        communication: BASE,
        opportunityId: 'opp-1',
        stage: 'in_process',
      },
    });
    renderWithProviders(
      <ul>
        <InboxRow
          comm={{
            ...BASE,
            classification: 'scheduling',
            opportunityStage: 'closed',
            proposedTransition: 'in_process',
          }}
          mode="linked"
        />
      </ul>,
    );
    await user.click(await screen.findByRole('button', { name: 'Reopen and move' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('It is Closed.');
    expect(posts(calls, '/communications/c1/accept-transition')).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Reopen and move to In process' }));
    await waitFor(() =>
      expect(posts(calls, '/communications/c1/accept-transition').map((c) => c.body)).toEqual([
        { reopen: true },
      ]),
    );
  });

  it('a spam row offers Not spam, which reclassifies the message as targeted outreach', async () => {
    const user = userEvent.setup();
    const spam: CommunicationView = {
      ...BASE,
      id: 'c2',
      subject: '50 roles for you',
      classification: 'solicitation',
      outreachKind: 'broadcast_spam',
      opportunityId: null,
      opportunityTitle: null,
      companyName: null,
      opportunityStage: null,
      proposedTransition: null,
    };
    const { calls } = mockApi({
      'POST /communications/c2/classify': { ...spam, outreachKind: 'targeted' },
    });
    renderWithProviders(
      <ul>
        <InboxRow comm={spam} mode="spam" />
      </ul>,
    );
    const row = await screen.findByRole('listitem', { name: '50 roles for you' });
    expect(within(row).queryByRole('button', { name: /Move to/ })).not.toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Not spam' }));
    await waitFor(() =>
      expect(posts(calls, '/communications/c2/classify').map((c) => c.body)).toEqual([
        { classification: 'solicitation', outreachKind: 'targeted' },
      ]),
    );
  });

  it('shows what was kept of the message, as text, and fetches no body', async () => {
    // Plan 3: the body is not stored, so there is nothing to fetch and the snippet is what the
    // dialog has to show. Markup inside it stays text: a message is untrusted input.
    const user = userEvent.setup();
    const { calls } = mockApi({});
    renderWithProviders(
      <ul>
        <InboxRow comm={{ ...BASE, snippet: '<b>Hello</b>\nSecond line' }} mode="linked" />
      </ul>,
    );
    await screen.findByRole('listitem', { name: 'Your application at Acme' });
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/<b>Hello<\/b>/)).toBeInTheDocument();
    expect(dialog.querySelector('b')).toBeNull();
    expect(calls.some((c) => c.path.endsWith('/body'))).toBe(false);
  });

  it('#149: says nothing about body source for the ordinary, non-degraded case', async () => {
    mockApi({});
    renderWithProviders(
      <ul>
        <InboxRow comm={BASE} mode="linked" />
      </ul>,
    );
    await screen.findByRole('listitem', { name: 'Your application at Acme' });
    expect(screen.queryByText('From snippet')).not.toBeInTheDocument();
  });

  it('#149: flags a message classified from the preview alone, not the full text', async () => {
    mockApi({});
    renderWithProviders(
      <ul>
        <InboxRow comm={{ ...BASE, bodySource: 'snippet' }} mode="linked" />
      </ul>,
    );
    await screen.findByRole('listitem', { name: 'Your application at Acme' });
    expect(screen.getByText('From snippet')).toBeInTheDocument();
  });

  it("wraps the row's message preview at reading width (#34)", async () => {
    // https://github.com/bgoleno/opportun/issues/34: the Inbox list is fluid, so on a wide window
    // the two-line preview would otherwise run the full row width.
    mockApi({});
    renderWithProviders(
      <ul>
        <InboxRow comm={BASE} mode="linked" />
      </ul>,
    );
    expect(await screen.findByText('Thank you for your interest...')).toHaveClass('max-w-prose');
  });

  it('a filtered row shows why it was filtered', async () => {
    mockApi({});
    renderWithProviders(
      <ul>
        <InboxRow
          comm={{
            ...BASE,
            classification: 'solicitation',
            outreachKind: 'irrelevant',
            mismatchReason: 'junior role, targets are staff level',
            proposedTransition: null,
          }}
          mode="filtered"
        />
      </ul>,
    );
    expect(await screen.findByText('junior role, targets are staff level')).toBeInTheDocument();
  });
});

describe('Inbox', () => {
  it('has the four views and lists each from its own query', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /communications': (c: ApiCall) => {
        const view = new URLSearchParams(c.search).get('view');
        const item =
          view === 'spam'
            ? { ...BASE, id: 's1', subject: 'Spam subject', outreachKind: 'broadcast_spam' }
            : { ...BASE, id: `${view}-1`, subject: `${view} subject` };
        return { items: [item], total: 1 };
      },
      'GET /integrations/gmail': { connected: true, lastSyncAt: null, count: 0, status: null },
    });
    renderWithProviders(<Inbox />);
    for (const name of [/^Needs review/, /^Linked/, /^Spam/, /^Filtered/]) {
      expect(await screen.findByRole('tab', { name })).toBeInTheDocument();
    }
    expect(await screen.findByText('needs_review subject')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /^Spam/ }));
    const panel = await screen.findByRole('tabpanel');
    expect(await within(panel).findByText('Spam subject')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Not spam' })).toBeInTheDocument();
    expect(calls.some((c) => c.search.includes('view=filtered'))).toBe(true);
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeInTheDocument();
  });

  it('lists Apple Mail messages next to Gmail ones, each with its source badge', async () => {
    mockApi({
      'GET /communications': {
        items: [
          { ...BASE, id: 'g1', subject: 'From Gmail' },
          { ...BASE, id: 'm1', channel: 'apple_mail', subject: 'From Apple Mail' },
        ],
        total: 2,
      },
      'GET /integrations/gmail': { connected: true, lastSyncAt: null, count: 0, status: null },
    });
    renderWithProviders(<Inbox />);
    const apple = await screen.findByRole('listitem', { name: 'From Apple Mail' });
    expect(
      within(apple).getByText('Apple Mail', { selector: '[data-slot="badge"]' }),
    ).toBeVisible();
    const gmail = screen.getByRole('listitem', { name: 'From Gmail' });
    expect(within(gmail).getByText('Gmail', { selector: '[data-slot="badge"]' })).toBeVisible();
  });

  it('filters the list by keyword, as its own request', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /communications': {
        items: [{ ...BASE, id: 'nr1', subject: 'needs_review subject' }],
        total: 1,
      },
      'GET /integrations/gmail': { connected: true, lastSyncAt: null, count: 0, status: null },
    });
    renderWithProviders(<Inbox />);
    await screen.findByText('needs_review subject');
    await user.type(screen.getByLabelText('Keyword'), 'manager');
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === 'GET' && c.path === '/communications' && c.search.includes('q=manager'),
        ),
      ).toBe(true),
    );
  });

  it('rejects the selected messages in one bulk call', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /communications': {
        items: [{ ...BASE, id: 'nr1', subject: 'pick me', opportunityId: null, needsReview: true }],
        total: 1,
      },
      'GET /integrations/gmail': { connected: true, lastSyncAt: null, count: 0, status: null },
      'POST /communications/bulk': { succeeded: 1, skipped: 0, changed: 0 },
    });
    renderWithProviders(<Inbox />);
    await screen.findByText('pick me');
    await user.click(screen.getByRole('checkbox', { name: /Select message from/ }));
    expect(await screen.findByText('1 selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Reject 1/ }));
    // Asked first (#647): rejecting wipes the subject, snippet and body for good.
    const dialog = await screen.findByRole('dialog', { name: 'Reject 1 message?' });
    await user.click(within(dialog).getByRole('button', { name: 'Reject 1' }));
    await waitFor(() => expect(posts(calls, '/communications/bulk')).toHaveLength(1));
    // With the link each was seen under (#666): the server leaves a changed one alone.
    expect(posts(calls, '/communications/bulk')[0]?.body).toMatchObject({
      items: [{ id: 'nr1', opportunityId: null }],
      action: { kind: 'reject' },
    });
  });

  it('says when selected messages were changed elsewhere and left as they are (#666)', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /communications': {
        items: [
          { ...BASE, id: 'nr1', subject: 'one', opportunityId: null, needsReview: true },
          { ...BASE, id: 'nr2', subject: 'two', opportunityId: null, needsReview: true },
        ],
        total: 2,
      },
      'GET /integrations/gmail': { connected: true, lastSyncAt: null, count: 0, status: null },
      'POST /communications/bulk': { succeeded: 1, skipped: 0, changed: 1 },
    });
    renderWithProviders(<Inbox />);
    await screen.findByText('one');
    for (const box of screen.getAllByRole('checkbox', { name: /Select message from/ })) {
      await user.click(box);
    }
    await user.click(await screen.findByRole('button', { name: /^Reject 2/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Reject 2 messages?' });
    await user.click(within(dialog).getByRole('button', { name: 'Reject 2' }));
    expect(await toastRegion().findByText('1 rejected')).toBeInTheDocument();
    expect(
      toastRegion().getByText(/1 was changed elsewhere and left as it is\./),
    ).toBeInTheDocument();
  });
});

// https://github.com/bgoleno/opportun/issues/645: after Sync now the Inbox keeps reading while the sync
// runs and its messages are classified, so the new mail, the counts and "Synced ..." show without a
// reload, and it stops once nothing is left to wait for.
// qa on #668: every row's Open original reads the Gmail status too, and each copy re-read the
// lists on a change, so one new status cost (rows + 1) times the list reads. The lists are read
// once per change, whatever the number of rows.
describe('Inbox Sync now: a sync that never reports (#645, qa)', () => {
  it('stops asking after two minutes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let clicked = false;
      const { calls } = mockApi({
        'GET /integrations/gmail': () => ({
          status: 200,
          body: {
            connected: true,
            lastSyncAt: 1,
            count: 0,
            status: clicked ? 'running' : 'ok',
            lookbackDays: 180,
            accountEmail: null,
            pendingClassify: 0,
          },
        }),
        'GET /communications': { items: [], total: 0 },
        'POST /integrations/gmail/sync': () => {
          clicked = true;
          return { status: 202, body: { jobId: 'job-1' } };
        },
      });
      const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
      renderWithProviders(<Inbox />);
      await user.click(await screen.findByRole('button', { name: /Sync now/ }));
      const reads = () => calls.filter((c) => c.path === '/integrations/gmail').length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(reads()).toBeGreaterThan(5);
      await vi.advanceTimersByTimeAsync(100_000);
      const atCap = reads();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reads()).toBe(atCap);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Inbox: one status change reads the lists once, however many rows (#645, qa)', () => {
  it('five rows on screen cost no more list reads than none', async () => {
    let count = 0;
    const readsFor = async (rows: number) => {
      const items = Array.from({ length: rows }, (_, i) => ({
        ...BASE,
        id: `r${i}`,
        subject: `row ${i}`,
        opportunityId: null,
        needsReview: true,
      }));
      const { calls } = mockApi({
        'GET /integrations/gmail': () => ({
          status: 200,
          body: {
            connected: true,
            lastSyncAt: 1,
            count: count,
            status: 'ok',
            lookbackDays: 180,
            accountEmail: 'me@gmail.test',
            pendingClassify: 0,
          },
        }),
        'GET /communications': { items, total: items.length },
      });
      const view = renderWithProviders(<Inbox />);
      if (rows > 0) await screen.findByText('row 0');
      else await screen.findByRole('button', { name: /Sync now/ });
      await waitFor(() => expect(calls.some((c) => c.path === '/integrations/gmail')).toBe(true));
      const lists = () => calls.filter((c) => c.path === '/communications').length;
      // Let the first reads settle, then one new status answer.
      await new Promise((r) => setTimeout(r, 50));
      const before = lists();
      count += 1;
      await view.queryClient.invalidateQueries({ queryKey: ['integrations', 'gmail'] });
      await new Promise((r) => setTimeout(r, 100));
      const used = lists() - before;
      view.unmount();
      return used;
    };
    const none = await readsFor(0);
    const five = await readsFor(5);
    expect(none).toBeGreaterThan(0);
    expect(five).toBe(none);
  });
});

describe('Inbox Sync now (#645)', () => {
  it('shows the new mail and the new sync time without a reload, then stops asking', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // Relative to the clock, never fixed: the poll compares the sync's time with the click's.
      const T0 = Date.now() - 24 * 60 * 60 * 1000;
      let T1 = 0;
      // Before the click, the last sync was T0. After it, the status reads: running, then synced
      // with 1 message still to classify, then all done. The message is in the list only once
      // the status has said it is classified, so a poll that stops early never shows it.
      let clicked = false;
      let readsAfter = 0;
      let classified = false;
      const status = () => {
        if (!clicked) {
          return { connected: true, lastSyncAt: T0, count: 0, status: 'ok', pendingClassify: 0 };
        }
        readsAfter += 1;
        if (readsAfter === 1) {
          return {
            connected: true,
            lastSyncAt: T0,
            count: 0,
            status: 'running',
            pendingClassify: 0,
          };
        }
        if (readsAfter === 2) {
          T1 = Date.now();
          return { connected: true, lastSyncAt: T1, count: 1, status: 'ok', pendingClassify: 1 };
        }
        classified = true;
        return { connected: true, lastSyncAt: T1, count: 1, status: 'ok', pendingClassify: 0 };
      };
      const fresh = {
        ...BASE,
        id: 'new1',
        subject: 'A brand new message',
        opportunityId: null,
        needsReview: true,
      };
      const { calls } = mockApi({
        // Wrapped: the payload's own `status` would read as the HTTP status.
        'GET /integrations/gmail': () => ({
          status: 200,
          body: { ...status(), lookbackDays: 180, accountEmail: null },
        }),
        'GET /communications': () =>
          classified ? { items: [fresh], total: 1 } : { items: [], total: 0 },
        'POST /integrations/gmail/sync': () => {
          clicked = true;
          return { status: 202, body: { jobId: 'job-1' } };
        },
      });
      const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
      renderWithProviders(<Inbox />);
      await screen.findByRole('button', { name: /Sync now/ });
      expect(screen.queryByText('A brand new message')).toBeNull();
      await user.click(screen.getByRole('button', { name: /Sync now/ }));
      for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(3000);
      expect(await screen.findByText('A brand new message')).toBeInTheDocument();
      expect(screen.getByText(/^Synced /)).toHaveTextContent(formatDateTime(T1));
      const reads = () => calls.filter((c) => c.path === '/integrations/gmail').length;
      const settled = reads();
      await vi.advanceTimersByTimeAsync(15000);
      expect(reads()).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });
});

// https://github.com/bgoleno/opportun/issues/647: bulk Reject wipes a message's subject, snippet and
// body for good. It only ever takes rows on screen, and it asks first, saying how many.
describe('Inbox bulk Reject (#647)', () => {
  const row = (id: string, subject: string) => ({
    ...BASE,
    id,
    subject,
    opportunityId: null,
    needsReview: true,
  });

  it('a selected row that leaves the list leaves the selection, and is not rejected', async () => {
    const user = userEvent.setup();
    let items = [row('nr1', 'first one'), row('nr2', 'second one')];
    const { calls } = mockApi({
      'GET /communications': () => ({ items, total: items.length }),
      'GET /integrations/gmail': { connected: true, lastSyncAt: null, count: 0, status: null },
      'POST /communications/bulk': { succeeded: 1, skipped: 0 },
    });
    const { queryClient } = renderWithProviders(<Inbox />);
    await screen.findByText('first one');
    for (const box of screen.getAllByRole('checkbox', { name: /Select message from/ })) {
      await user.click(box);
    }
    expect(await screen.findByText('2 selected')).toBeInTheDocument();
    // The first leaves the tab, as a row linked or reclassified from its own buttons does.
    items = [row('nr2', 'second one')];
    await queryClient.invalidateQueries();
    await waitFor(() => expect(screen.queryByText('first one')).toBeNull());
    expect(await screen.findByText('1 selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Reject 1/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Reject 1 message?' });
    await user.click(within(dialog).getByRole('button', { name: 'Reject 1' }));
    await waitFor(() => expect(posts(calls, '/communications/bulk')).toHaveLength(1));
    expect(posts(calls, '/communications/bulk')[0]?.body).toMatchObject({
      items: [{ id: 'nr2', opportunityId: null }],
    });
  });

  it('asks first, says how many and that it is for good, and Cancel rejects nothing', async () => {
    const user = userEvent.setup();
    const items = [row('nr1', 'first one'), row('nr2', 'second one')];
    const { calls } = mockApi({
      'GET /communications': { items, total: items.length },
      'GET /integrations/gmail': { connected: true, lastSyncAt: null, count: 0, status: null },
      'POST /communications/bulk': { succeeded: 2, skipped: 0 },
    });
    renderWithProviders(<Inbox />);
    await screen.findByText('first one');
    for (const box of screen.getAllByRole('checkbox', { name: /Select message from/ })) {
      await user.click(box);
    }
    await user.click(await screen.findByRole('button', { name: /^Reject 2/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Reject 2 messages?' });
    expect(dialog).toHaveTextContent(/subject, snippet and body/);
    expect(dialog).toHaveTextContent(/cannot be undone/);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts(calls, '/communications/bulk')).toHaveLength(0);
    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });
});

// https://github.com/bgoleno/opportun/issues/652: a failed Ignore said nothing (Move to and Not spam
// both toast theirs), and a filter that matched nothing showed the tab's own empty text, which
// reads as an empty inbox.
describe('Inbox: a failed Ignore, and a filter that matches nothing (#652)', () => {
  it('a failed Ignore says so, and the suggestion stays', async () => {
    const user = userEvent.setup();
    mockApi({
      'DELETE /communications/c1/proposed-transition': () => ({
        status: 500,
        body: { error: { code: 'server_error', message: 'The server could not do that.' } },
      }),
    });
    renderWithProviders(
      <ul>
        <InboxRow comm={BASE} mode="linked" />
      </ul>,
    );
    const row = await screen.findByRole('listitem', { name: 'Your application at Acme' });
    await user.click(within(row).getByRole('button', { name: 'Ignore' }));
    expect(await screen.findByText('Suggestion not dismissed')).toBeInTheDocument();
    expect(within(row).getByText('Suggested stage')).toBeInTheDocument();
  });

  it('a filter that matches nothing says so, not that the tab is empty', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /communications': (call: { search: string }) => ({
        status: 200,
        body: call.search.includes('q=')
          ? { items: [], total: 0 }
          : { items: [{ ...BASE, id: 'nr1', subject: 'needs_review subject' }], total: 1 },
      }),
      'GET /integrations/gmail': { connected: true, lastSyncAt: null, count: 0, status: null },
    });
    renderWithProviders(<Inbox />);
    await screen.findByText('needs_review subject');
    await user.type(screen.getByLabelText('Keyword'), 'nothing like this');
    expect(await screen.findByText('No messages match these filters.')).toBeInTheDocument();
    expect(screen.queryByText('Nothing needs review.')).toBeNull();
  });

  // qa on #706: a sender or a source alone counts as a filter too, not just a keyword.
  it.each([
    ['a sender', 'sender='],
    ['a source', 'channel='],
  ])('%s that matches nothing says so too', async (_what, param) => {
    const user = userEvent.setup();
    mockApi({
      'GET /communications': (call: { search: string }) => ({
        status: 200,
        body: call.search.includes(param)
          ? { items: [], total: 0 }
          : { items: [{ ...BASE, id: 'nr1', subject: 'needs_review subject' }], total: 1 },
      }),
      'GET /integrations/gmail': { connected: true, lastSyncAt: null, count: 0, status: null },
    });
    renderWithProviders(<Inbox />);
    await screen.findByText('needs_review subject');
    if (param === 'sender=') {
      await user.type(screen.getByLabelText('Sender'), 'nobody@nowhere.example');
    } else {
      const source = screen.getByLabelText('Source') as HTMLSelectElement;
      const option = [...source.options].find((o) => o.value !== '')!;
      await user.selectOptions(source, option.value);
    }
    expect(await screen.findByText('No messages match these filters.')).toBeInTheDocument();
    expect(screen.queryByText('Nothing needs review.')).toBeNull();
  });

  it('with no filter set, an empty tab still says its own empty text', async () => {
    mockApi({
      'GET /communications': { items: [], total: 0 },
      'GET /integrations/gmail': { connected: true, lastSyncAt: null, count: 0, status: null },
    });
    renderWithProviders(<Inbox />);
    expect(await screen.findByText('Nothing needs review.')).toBeInTheDocument();
    expect(screen.queryByText('No messages match these filters.')).toBeNull();
  });
});

// https://github.com/bgoleno/opportun/issues/646: each tab asked for 200 and rendered only those,
// with no paging and no "of N", while its badge showed the true total. Paged here at 2 a page (the
// app's page is 200, the server's cap) so the test renders a few rows.
describe('Inbox: a tab over one page (#646)', () => {
  let ALL = Array.from({ length: 5 }, (_, i) => ({
    ...BASE,
    id: `m${i + 1}`,
    subject: `message ${i + 1}`,
    opportunityId: null,
    needsReview: true,
  }));

  function serve() {
    return mockApi({
      'GET /communications': (call: { search: string }) => {
        const params = new URLSearchParams(call.search);
        const limit = Number(params.get('limit'));
        const offset = Number(params.get('offset') ?? 0);
        return {
          status: 200,
          body: { items: ALL.slice(offset, offset + limit), total: ALL.length },
        };
      },
      'GET /integrations/gmail': { connected: true, lastSyncAt: null, count: 0, status: null },
    });
  }

  it('every message can be reached, and the tab says how many are shown of the total', async () => {
    const user = userEvent.setup();
    serve();
    renderWithProviders(<Inbox pageSize={2} />);
    expect(await screen.findByText('message 1')).toBeInTheDocument();
    expect(screen.getByText('Showing 1–2 of 5')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('message 3')).toBeInTheDocument();
    expect(screen.queryByText('message 1')).toBeNull();
    expect(screen.getByText('Showing 3–4 of 5')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('message 5')).toBeInTheDocument();
    expect(screen.getByText('Showing 5–5 of 5')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(await screen.findByText('message 3')).toBeInTheDocument();
  });

  it('a page left empty steps back to the last page with messages', async () => {
    const user = userEvent.setup();
    serve();
    const { queryClient } = renderWithProviders(<Inbox pageSize={2} />);
    await screen.findByText('message 1');
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('message 3');
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('message 5');
    // Its only message leaves the tab (rejected or linked from its own buttons).
    const kept = ALL;
    ALL = ALL.slice(0, 4);
    try {
      await queryClient.invalidateQueries();
      expect(await screen.findByText('Showing 3–4 of 4')).toBeInTheDocument();
      expect(screen.getByText('message 3')).toBeInTheDocument();
    } finally {
      ALL = kept;
    }
  });

  it('a tab that fits on one page shows no pager', async () => {
    mockApi({
      'GET /communications': { items: ALL.slice(0, 2), total: 2 },
      'GET /integrations/gmail': { connected: true, lastSyncAt: null, count: 0, status: null },
    });
    renderWithProviders(<Inbox pageSize={2} />);
    expect(await screen.findByText('message 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull();
    expect(screen.queryByText(/^Showing /)).toBeNull();
  });

  it('a filter change goes back to the first page', async () => {
    const user = userEvent.setup();
    const { calls } = serve();
    renderWithProviders(<Inbox pageSize={2} />);
    await screen.findByText('message 1');
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('message 3');
    await user.type(screen.getByRole('searchbox', { name: 'Keyword' }), 'message');
    await waitFor(() =>
      expect(
        calls.some((c) => c.search.includes('q=message') && !/offset=[1-9]/.test(c.search)),
      ).toBe(true),
    );
    expect(await screen.findByText('Showing 1–2 of 5')).toBeInTheDocument();
  });
});

// Refs #646, its review (qa, tl): while the next page loads, the page before stays on screen
// (keepPreviousData), and the pager read ahead past the total ("Showing 401-600 of 450"); and the
// step-back for an emptied page must not act on those placeholder rows.
describe('Inbox paging while the next page loads (#646 review)', () => {
  const ALL = Array.from({ length: 5 }, (_, i) => ({
    ...BASE,
    id: `m${i + 1}`,
    subject: `message ${i + 1}`,
    opportunityId: null,
    needsReview: true,
  }));

  it('the range never reads past the total, even with the page before still on screen', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    mockApi({
      'GET /communications': async (call: { search: string }) => {
        const params = new URLSearchParams(call.search);
        const limit = Number(params.get('limit'));
        const offset = Number(params.get('offset') ?? 0);
        if (offset === 4) await held;
        return {
          status: 200,
          body: { items: ALL.slice(offset, offset + limit), total: ALL.length },
        };
      },
      'GET /integrations/gmail': { connected: true, lastSyncAt: null, count: 0, status: null },
    });
    renderWithProviders(<Inbox pageSize={2} />);
    await screen.findByText('message 1');
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('message 3');
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    // The last page is loading: messages 3 and 4 are still shown.
    expect(await screen.findByText('Showing 5–5 of 5')).toBeInTheDocument();
    expect(screen.queryByText(/of 5$/)?.textContent).not.toMatch(/5–6/);
    release();
    expect(await screen.findByText('message 5')).toBeInTheDocument();
    expect(screen.getByText('Showing 5–5 of 5')).toBeInTheDocument();
  });

  it('a page still loading is not stepped back from, even when the rows on screen run out', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let rows = ALL;
    const { calls } = mockApi({
      'GET /communications': async (call: { search: string }) => {
        const params = new URLSearchParams(call.search);
        const limit = Number(params.get('limit'));
        const offset = Number(params.get('offset') ?? 0);
        if (offset === 2 && rows.length === 0) await held;
        return {
          status: 200,
          body: { items: rows.slice(offset, offset + limit), total: rows.length },
        };
      },
      'GET /integrations/gmail': { connected: true, lastSyncAt: null, count: 0, status: null },
    });
    const { queryClient } = renderWithProviders(<Inbox pageSize={2} />);
    await screen.findByText('message 1');
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('message 3');
    const pageReads = () =>
      calls.filter((c) => c.path === '/communications' && /limit=2&offset=0/.test(c.search)).length;
    const before = pageReads();
    // Everything leaves the tab; page 2 refetches, and its answer is held.
    rows = [];
    void queryClient.invalidateQueries();
    await new Promise((r) => setTimeout(r, 50));
    // While page 2 is still loading, the list does not jump back to page 1 on its own.
    expect(pageReads()).toBe(before);
    release();
    expect(await screen.findByText('Nothing needs review.')).toBeInTheDocument();
  });
});

// https://github.com/bgoleno/opportun/issues/678 criterion 3 (qa on #672): with only unlinked rows
// in the bulk tests, a bar that always sent null links passed. A linked row sends its link.
describe('Inbox bulk Reject sends each row its own link (#678)', () => {
  it('a linked row goes with its opportunity, an unlinked one with null', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /communications': {
        items: [
          { ...BASE, id: 'l1', subject: 'linked one', opportunityId: 'opp-7' },
          { ...BASE, id: 'u1', subject: 'unlinked one', opportunityId: null },
        ],
        total: 2,
      },
      'GET /integrations/gmail': { connected: true, lastSyncAt: null, count: 0, status: null },
      'POST /communications/bulk': { succeeded: 2, skipped: 0, changed: 0 },
    });
    renderWithProviders(<Inbox initialTab="linked" />);
    await screen.findByText('linked one');
    for (const box of screen.getAllByRole('checkbox', { name: /Select message from/ })) {
      await user.click(box);
    }
    await user.click(await screen.findByRole('button', { name: /^Reject 2/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Reject 2 messages?' });
    await user.click(within(dialog).getByRole('button', { name: 'Reject 2' }));
    await waitFor(() => expect(posts(calls, '/communications/bulk')).toHaveLength(1));
    expect(posts(calls, '/communications/bulk')[0]?.body).toMatchObject({
      items: [
        { id: 'l1', opportunityId: 'opp-7' },
        { id: 'u1', opportunityId: null },
      ],
    });
  });
});

// https://github.com/bgoleno/opportun/issues/678, qa's O1 and O2 (third exploratory pass).
describe('Inbox bulk Reject: focus and filters (#678)', () => {
  const rows = [
    { ...BASE, id: 'a1', subject: 'alpha one', opportunityId: null, needsReview: true },
    { ...BASE, id: 'b1', subject: 'beta one', opportunityId: null, needsReview: true },
  ];

  it('after a confirmed bulk reject, focus is on the message list, not the page body', async () => {
    const user = userEvent.setup();
    let gone = false;
    mockApi({
      'GET /communications': () => ({
        status: 200,
        body: gone ? { items: [rows[1]], total: 1 } : { items: rows, total: 2 },
      }),
      'GET /integrations/gmail': { connected: true, lastSyncAt: null, count: 0, status: null },
      'POST /communications/bulk': () => {
        gone = true;
        return { succeeded: 1, skipped: 0, changed: 0 };
      },
    });
    renderWithProviders(<Inbox />);
    await screen.findByText('alpha one');
    await user.click(screen.getAllByRole('checkbox', { name: /Select message from/ })[0]!);
    await user.click(await screen.findByRole('button', { name: /^Reject 1/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Reject 1 message?' });
    await user.click(within(dialog).getByRole('button', { name: 'Reject 1' }));
    await waitFor(() => expect(screen.queryByText('alpha one')).toBeNull());
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement).toBe(
      screen.getByRole('region', { name: 'Needs review messages' }),
    );
  });

  it('a filter that still lists the selected row keeps it selected, and its confirmation open', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /communications': (call: { search: string }) => ({
        status: 200,
        // The keyword "one" still matches both rows.
        body: { items: rows, total: 2, search: call.search },
      }),
      'GET /integrations/gmail': { connected: true, lastSyncAt: null, count: 0, status: null },
    });
    renderWithProviders(<Inbox />);
    await screen.findByText('alpha one');
    await user.click(screen.getAllByRole('checkbox', { name: /Select message from/ })[0]!);
    // Typed, then the confirmation opened before the keyword's short delay has applied it.
    await user.type(screen.getByRole('searchbox', { name: 'Keyword' }), 'one');
    await user.click(await screen.findByRole('button', { name: /^Reject 1/ }));
    expect(await screen.findByRole('dialog', { name: 'Reject 1 message?' })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.getByRole('dialog', { name: 'Reject 1 message?' })).toBeInTheDocument();
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });
});

// The EM's points for #712's final head (from tl and qa on #706 and #712).
describe('Inbox bulk Reject: what a loading list may and may not do (#678)', () => {
  const rows = [
    { ...BASE, id: 'a1', subject: 'alpha one', opportunityId: null, needsReview: true },
    { ...BASE, id: 'b1', subject: 'beta one', opportunityId: null, needsReview: true },
  ];

  // qa: the selection is pruned of rows that leave, so a row that comes back is not selected
  // again on its own. Without the pruning, the bar's on-screen filter hid it, and nothing failed.
  it('a selected row that leaves and comes back is no longer selected', async () => {
    const user = userEvent.setup();
    let items = rows;
    mockApi({
      'GET /communications': () => ({ status: 200, body: { items, total: items.length } }),
      'GET /integrations/gmail': { connected: true, lastSyncAt: null, count: 0, status: null },
    });
    const { queryClient } = renderWithProviders(<Inbox />);
    await screen.findByText('alpha one');
    await user.click(screen.getAllByRole('checkbox', { name: /Select message from/ })[0]!);
    expect(await screen.findByText('1 selected')).toBeInTheDocument();
    items = [rows[1]!];
    await queryClient.invalidateQueries();
    await waitFor(() => expect(screen.queryByText('alpha one')).toBeNull());
    items = rows;
    await queryClient.invalidateQueries();
    expect(await screen.findByText('alpha one')).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox', { name: /Select message from/ })[0]).not.toBeChecked();
    expect(screen.queryByText(/selected$/)).toBeNull();
  });

  // The EM's main point: while a new filter loads, the rows before it stay on screen, and a row
  // that filter is about to hide still looked selected. Confirming then rejected it unseen.
  it('Reject is not offered while the list is still loading a new filter', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    mockApi({
      'GET /communications': async (call: { search: string }) => {
        if (call.search.includes('q=')) {
          await held;
          return { status: 200, body: { items: [rows[1]], total: 1 } };
        }
        return { status: 200, body: { items: rows, total: 2 } };
      },
      'GET /integrations/gmail': { connected: true, lastSyncAt: null, count: 0, status: null },
    });
    renderWithProviders(<Inbox />);
    await screen.findByText('alpha one');
    await user.click(screen.getAllByRole('checkbox', { name: /Select message from/ })[0]!);
    await user.type(screen.getByRole('searchbox', { name: 'Keyword' }), 'beta');
    // The filter has applied and is loading; the old rows are still shown. The button is marked
    // unavailable rather than disabled (#841), so focus can return to it, and a press does nothing.
    const reject = screen.getByRole('button', { name: /^Reject 1/ });
    await waitFor(() => expect(reject).toHaveAttribute('aria-disabled', 'true'));
    await user.click(reject);
    expect(screen.queryByRole('dialog')).toBeNull();
    release();
    // The answer hides the selected row: it leaves the selection, and the bar with it.
    await waitFor(() => expect(screen.queryByText('alpha one')).toBeNull());
    expect(screen.queryByRole('button', { name: /^Reject \d/ })).toBeNull();
  });

  // tl and qa on #706: after a step-back to a page no longer cached, the emptied page stood in
  // for it, so the tab's empty text and a pager ("Showing 200-200 of 400") showed at once.
  it('a step-back to a page not cached shows neither the empty text nor a pager while it loads', async () => {
    const user = userEvent.setup();
    let all = [
      ...rows,
      { ...BASE, id: 'c1', subject: 'gamma one', opportunityId: null, needsReview: true },
    ];
    let release!: () => void;
    let holdFirst = false;
    const held = new Promise<void>((r) => (release = r));
    mockApi({
      'GET /communications': async (call: { search: string }) => {
        const params = new URLSearchParams(call.search);
        const limit = Number(params.get('limit'));
        const offset = Number(params.get('offset') ?? 0);
        if (offset === 0 && limit === 2 && holdFirst) await held;
        return {
          status: 200,
          body: { items: all.slice(offset, offset + limit), total: all.length },
        };
      },
      'GET /integrations/gmail': { connected: true, lastSyncAt: null, count: 0, status: null },
    });
    const { queryClient } = renderWithProviders(<Inbox pageSize={2} />);
    await screen.findByText('alpha one');
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('gamma one');
    // Page 1's cache has expired; then page 2's only message leaves the tab.
    queryClient.removeQueries({
      predicate: (q) => q.queryKey.includes(0) && q.queryKey.includes(2),
    });
    holdFirst = true;
    all = rows;
    await queryClient.invalidateQueries();
    await waitFor(() => expect(screen.queryByText('gamma one')).toBeNull());
    expect(screen.queryByText('Nothing needs review.')).toBeNull();
    expect(screen.queryByText(/^Showing /)).toBeNull();
    release();
    expect(await screen.findByText('alpha one')).toBeInTheDocument();
  });
});

// https://github.com/bgoleno/opportun/issues/758 (qa on #712): a confirmation opened while the
// keyword was still in its debounce could still be confirmed once the new filter loaded, and act on
// a row that filter was about to hide. The dialog's Confirm waits for the list, as the bar's button
// does.
describe('Inbox bulk Reject: the confirmation waits for the list too (#758)', () => {
  const rows = [
    { ...BASE, id: 'a1', subject: 'alpha one', opportunityId: null, needsReview: true },
    { ...BASE, id: 'b1', subject: 'beta one', opportunityId: null, needsReview: true },
  ];

  function heldFilter(answer: typeof rows) {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const { calls } = mockApi({
      'GET /communications': async (call: { search: string }) => {
        if (call.search.includes('q=')) {
          await held;
          return { status: 200, body: { items: answer, total: answer.length } };
        }
        return { status: 200, body: { items: rows, total: 2 } };
      },
      'GET /integrations/gmail': { connected: true, lastSyncAt: null, count: 0, status: null },
      'POST /communications/bulk': { succeeded: 1, skipped: 0, changed: 0 },
    });
    return { calls, release };
  }

  async function confirmOpenThenFilter(user: ReturnType<typeof userEvent.setup>, keyword: string) {
    await screen.findByText('alpha one');
    await user.click(screen.getAllByRole('checkbox', { name: /Select message from/ })[0]!);
    // Typed, then the confirmation opened before the keyword's short delay has applied it.
    await user.type(screen.getByRole('searchbox', { name: 'Keyword' }), keyword);
    await user.click(screen.getByRole('button', { name: /^Reject 1/ }));
    return await screen.findByRole('dialog', { name: 'Reject 1 message?' });
  }

  it('Confirm is not offered while the new filter loads, and a hidden row is never rejected', async () => {
    const user = userEvent.setup();
    const { calls, release } = heldFilter([rows[1]!]);
    renderWithProviders(<Inbox />);
    const dialog = await confirmOpenThenFilter(user, 'beta');
    // The filter has applied and is loading; the row about to go is still shown, and selected.
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Reject 1' })).toBeDisabled(),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Reject 1' }));
    expect(posts(calls, '/communications/bulk')).toHaveLength(0);
    release();
    // The answer hides it: it leaves the selection, and the bar and its dialog with it.
    await waitFor(() => expect(screen.queryByText('alpha one')).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posts(calls, '/communications/bulk')).toHaveLength(0);
  });

  it('once the list has loaded and still holds the row, Confirm rejects it', async () => {
    const user = userEvent.setup();
    const { calls, release } = heldFilter(rows);
    renderWithProviders(<Inbox />);
    const dialog = await confirmOpenThenFilter(user, 'one');
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Reject 1' })).toBeDisabled(),
    );
    release();
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Reject 1' })).toBeEnabled(),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Reject 1' }));
    await waitFor(() => expect(posts(calls, '/communications/bulk')).toHaveLength(1));
  });
});

// qa on #838: what the list's reload does to a selection and its open confirmation (#841).
describe('Inbox bulk Reject: a reload behind the confirmation (#841)', () => {
  const rows = [
    { ...BASE, id: 'a1', subject: 'alpha one', opportunityId: null, needsReview: true },
    { ...BASE, id: 'b1', subject: 'beta one', opportunityId: null, needsReview: true },
  ];

  /** The filtered list is held until released, then answers `answer` (or fails). */
  function heldFilter(answer: typeof rows | 'fail') {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const { calls } = mockApi({
      'GET /communications': async (call: { search: string }) => {
        if (call.search.includes('q=')) {
          await held;
          if (answer === 'fail') {
            return {
              status: 500,
              body: { error: { code: 'server_error', message: 'The server could not do that.' } },
            };
          }
          return { status: 200, body: { items: answer, total: answer.length } };
        }
        return { status: 200, body: { items: rows, total: 2 } };
      },
      'GET /integrations/gmail': { connected: true, lastSyncAt: null, count: 0, status: null },
      'POST /communications/bulk': { succeeded: 1, skipped: 0, changed: 0 },
    });
    return { calls, release };
  }

  /** Selects `count` rows, types `keyword`, and opens the confirmation before it applies. */
  async function openThenFilter(
    user: ReturnType<typeof userEvent.setup>,
    keyword: string,
    count: 1 | 2,
  ) {
    await screen.findByText('alpha one');
    const boxes = screen.getAllByRole('checkbox', { name: /Select message from/ });
    for (const box of boxes.slice(0, count)) await user.click(box);
    await user.type(screen.getByRole('searchbox', { name: 'Keyword' }), keyword);
    await user.click(screen.getByRole('button', { name: count === 1 ? /^Reject 1/ : /^Reject 2/ }));
    const name = count === 1 ? 'Reject 1 message?' : 'Reject 2 messages?';
    return await screen.findByRole('dialog', { name });
  }

  it('a reload that fails keeps the selection, and says the list could not refresh', async () => {
    const user = userEvent.setup();
    const { release } = heldFilter('fail');
    renderWithProviders(<Inbox />);
    await screen.findByText('alpha one');
    await user.click(screen.getAllByRole('checkbox', { name: /Select message from/ })[0]!);
    await user.type(screen.getByRole('searchbox', { name: 'Keyword' }), 'beta');
    release();
    expect(await screen.findByText(/couldn't refresh/)).toBeInTheDocument();
    expect(screen.getByText('alpha one')).toBeInTheDocument();
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox', { name: /Select message from/ })[0]).toBeChecked();
  });

  it('a reload that drops some of the rows closes the confirmation, says so, and rejects nothing', async () => {
    const user = userEvent.setup();
    const { calls, release } = heldFilter([rows[1]!]);
    renderWithProviders(<Inbox />);
    await openThenFilter(user, 'beta', 2);
    release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Nothing was rejected')).toBeInTheDocument();
    expect(
      screen.getByText(
        '1 of the 2 selected messages is no longer listed. Check the selection and reject again.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(posts(calls, '/communications/bulk')).toHaveLength(0);
  });

  it('a reload that drops every row closes the confirmation and says so', async () => {
    const user = userEvent.setup();
    const { calls, release } = heldFilter([]);
    renderWithProviders(<Inbox />);
    await openThenFilter(user, 'zeta', 1);
    release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Nothing was rejected')).toBeInTheDocument();
    expect(screen.getByText('The selected message is no longer listed.')).toBeInTheDocument();
    expect(posts(calls, '/communications/bulk')).toHaveLength(0);
  });

  it('Escape during the reload returns focus to the Reject button that opened it', async () => {
    const user = userEvent.setup();
    const { release } = heldFilter(rows);
    renderWithProviders(<Inbox />);
    const dialog = await openThenFilter(user, 'one', 1);
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Reject 1' })).toBeDisabled(),
    );
    // jsdom has no native <dialog> behaviour: as a browser does, focus is inside the dialog, and
    // Escape closes it (its close event).
    within(dialog).getByRole('button', { name: 'Cancel' }).focus();
    fireEvent(dialog, new Event('close'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const opener = screen.getByRole('button', { name: /^Reject 1/ });
    expect(opener).toHaveFocus();
    // Still not offered while the list loads (#678), but focusable, so focus can return to it.
    expect(opener).toHaveAttribute('aria-disabled', 'true');
    await user.click(opener);
    expect(screen.queryByRole('dialog')).toBeNull();
    release();
  });

  it('a reload that keeps every row leaves the confirmation open, with no message', async () => {
    const user = userEvent.setup();
    const { release } = heldFilter(rows);
    renderWithProviders(<Inbox />);
    const dialog = await openThenFilter(user, 'one', 2);
    release();
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Reject 2' })).toBeEnabled(),
    );
    expect(screen.getByRole('dialog', { name: 'Reject 2 messages?' })).toBeInTheDocument();
    expect(screen.queryByText('Nothing was rejected')).toBeNull();
  });
});
