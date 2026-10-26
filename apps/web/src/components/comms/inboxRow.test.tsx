import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
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
      'POST /communications/bulk': { succeeded: 1, skipped: 0 },
    });
    renderWithProviders(<Inbox />);
    await screen.findByText('pick me');
    await user.click(screen.getByRole('checkbox', { name: /Select message from/ }));
    expect(await screen.findByText('1 selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Reject 1/ }));
    await waitFor(() => expect(posts(calls, '/communications/bulk')).toHaveLength(1));
    expect(posts(calls, '/communications/bulk')[0]?.body).toMatchObject({
      ids: ['nr1'],
      action: { kind: 'reject' },
    });
  });
});
