import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { formatDateTime } from '@/lib/opportunities';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
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
    expect(await screen.findByText('1 rejected')).toBeInTheDocument();
    expect(screen.getByText(/1 was changed elsewhere and left as it is\./)).toBeInTheDocument();
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
