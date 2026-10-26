import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { fetchAllPendingResultIds, type DiscoveryResult } from './api';
import { groupResults } from './groupResults';
import { QueueGroupRow, QueueRow } from './QueueRow';
import { ReviewQueue } from './ReviewQueue';

const NOW = Date.now();

function result(over: Partial<DiscoveryResult> & { id: string }): DiscoveryResult {
  return {
    runId: 'run-1',
    sourceId: 'src-1',
    sourceKind: 'ats_greenhouse',
    roleTargetId: null,
    posting: {
      company: 'Initech',
      title: 'Staff Engineer',
      descriptionMd: 'Build things.',
      postingUrl: 'https://boards.greenhouse.io/initech/jobs/1',
      location: 'Remote',
    },
    dedupeKey: null,
    aiScore: 80,
    aiRationale: 'Strong match on platform work.',
    resolution: 'full',
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

const HOSTILE = '<script>window.__pwned = true</script><img src=x onerror="window.__pwned=1">';

describe('QueueRow', () => {
  it('renders a posting containing a literal <script> string inert, as text (Review Focus 1)', () => {
    const r = result({
      id: 'r-hostile',
      posting: {
        company: 'Evil <b>Corp</b>',
        title: `Engineer ${HOSTILE}`,
        descriptionMd: `**bold** [link](javascript:alert(1)) ${HOSTILE}`,
        postingUrl: 'https://example.com/job',
        location: '<i>Nowhere</i>',
        compNote: '<script>x()</script>',
      },
      aiRationale: '<script>alert("rationale")</script>',
    });
    const { container } = render(
      <ul>
        <QueueRow
          result={r}
          selected={false}
          onSelect={vi.fn()}
          onAccept={vi.fn()}
          onDismiss={vi.fn()}
          onOpen={vi.fn()}
          checked={false}
          onToggleChecked={vi.fn()}
        />
      </ul>,
    );
    // No markup from the posting reached the DOM.
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b, i, strong, em')).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect((window as unknown as { __pwned?: unknown }).__pwned).toBeUndefined();
    // The strings are shown literally.
    expect(screen.getByText(`Engineer ${HOSTILE}`)).toBeInTheDocument();
    expect(container).toHaveTextContent('Evil <b>Corp</b>');
    expect(container).toHaveTextContent('**bold** [link](javascript:alert(1))');
    expect(container).toHaveTextContent('<script>alert("rationale")</script>');
    expect(container).toHaveTextContent('<i>Nowhere</i>');
  });

  it('shows the score badge, rationale and resolution chip', () => {
    render(
      <ul>
        <QueueRow
          result={result({ id: 'r1', aiScore: 72.4, resolution: 'needs_capture' })}
          selected
          onSelect={vi.fn()}
          onAccept={vi.fn()}
          onDismiss={vi.fn()}
          onOpen={vi.fn()}
          checked={false}
          onToggleChecked={vi.fn()}
        />
      </ul>,
    );
    expect(screen.getByLabelText('AI score 72 of 100')).toHaveTextContent('72');
    expect(screen.getByText('Strong match on platform work.')).toBeInTheDocument();
    expect(screen.getByText('Needs capture')).toBeInTheDocument();
  });

  it('only links http(s) posting urls', () => {
    const { container } = render(
      <ul>
        <QueueRow
          result={result({
            id: 'r2',
            posting: { company: 'A', title: 'B', postingUrl: 'javascript:alert(1)' },
          })}
          selected={false}
          onSelect={vi.fn()}
          onAccept={vi.fn()}
          onDismiss={vi.fn()}
          onOpen={vi.fn()}
          checked={false}
          onToggleChecked={vi.fn()}
        />
      </ul>,
    );
    expect(container.querySelector('a')).toBeNull();
  });

  it('groups the posting link with Accept and Dismiss, named for the item', () => {
    render(
      <ul>
        <QueueRow
          result={result({
            id: 'r3',
            posting: {
              company: 'Initech',
              title: 'Staff Engineer',
              postingUrl: 'https://boards.greenhouse.io/initech/jobs/1',
            },
          })}
          selected={false}
          onSelect={vi.fn()}
          onAccept={vi.fn()}
          onDismiss={vi.fn()}
          onOpen={vi.fn()}
          checked={false}
          onToggleChecked={vi.fn()}
        />
      </ul>,
    );
    const posting = screen.getByRole('link', {
      name: 'Open posting for Staff Engineer at Initech',
    });
    const accept = screen.getByRole('button', { name: /^Accept/ });
    // Same parent as Accept and Dismiss: moved in with the other actions, not off on its own.
    expect(posting.parentElement).toBe(accept.parentElement);
  });

  it('offers no posting control at all when the result has no posting URL', () => {
    render(
      <ul>
        <QueueRow
          result={result({ id: 'r4', posting: { company: 'A', title: 'B', postingUrl: null } })}
          selected={false}
          onSelect={vi.fn()}
          onAccept={vi.fn()}
          onDismiss={vi.fn()}
          onOpen={vi.fn()}
          checked={false}
          onToggleChecked={vi.fn()}
        />
      </ul>,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('QueueGroupRow (issue #191)', () => {
  const members = [
    result({
      id: 'r-ca',
      dedupeKey: 'vandelay|technical product manager enterprise products|california',
      posting: {
        company: 'VANDELAY',
        title: 'Technical Product Manager - Enterprise Products',
        postingUrl: 'https://vandelay.example/jobs/ca',
        location: 'California, United States',
      },
    }),
    result({
      id: 'r-co',
      dedupeKey: 'vandelay|technical product manager enterprise products|colorado',
      posting: {
        company: 'VANDELAY',
        title: 'Technical Product Manager - Enterprise Products',
        postingUrl: null,
        location: 'Colorado, United States',
      },
    }),
    result({
      id: 'r-nc',
      dedupeKey: 'vandelay|technical product manager enterprise products|north carolina',
      posting: {
        company: 'VANDELAY',
        title: 'Technical Product Manager - Enterprise Products',
        postingUrl: 'https://vandelay.example/jobs/nc',
        location: 'North Carolina, United States',
      },
    }),
  ];

  it('shows the shared title and company once, and every location, linked where a posting url exists', () => {
    const [group] = groupResults(members);
    render(
      <ul>
        <QueueGroupRow
          group={group!}
          selected={false}
          onSelect={vi.fn()}
          onAcceptAll={vi.fn()}
          onDismissAll={vi.fn()}
          onOpen={vi.fn()}
        />
      </ul>,
    );
    // The title and company appear once each, not once per location.
    expect(screen.getAllByText('Technical Product Manager - Enterprise Products')).toHaveLength(1);
    expect(screen.getAllByText('VANDELAY')).toHaveLength(1);
    expect(screen.getByText('California, United States')).toBeInTheDocument();
    expect(screen.getByText('North Carolina, United States')).toBeInTheDocument();
    // Colorado has no posting url: its location shows as plain text, not a link.
    expect(screen.getByText('Colorado, United States').closest('a')).toBeNull();
    expect(screen.getByRole('link', { name: 'California, United States' })).toHaveAttribute(
      'href',
      'https://vandelay.example/jobs/ca',
    );
  });

  it('labels the actions as covering every location in the group, not just one', () => {
    const [group] = groupResults(members);
    render(
      <ul>
        <QueueGroupRow
          group={group!}
          selected={false}
          onSelect={vi.fn()}
          onAcceptAll={vi.fn()}
          onDismissAll={vi.fn()}
          onOpen={vi.fn()}
        />
      </ul>,
    );
    expect(screen.getByRole('button', { name: /^Accept all 3/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Dismiss all 3/ })).toBeInTheDocument();
  });

  it('renders hostile location text as plain text, not markup (same guarantee as QueueRow)', () => {
    const hostileMembers = [
      result({
        id: 'h1',
        dedupeKey: 'acme|engineer|a',
        posting: { company: 'Acme', title: 'Engineer', postingUrl: null, location: HOSTILE },
      }),
      result({
        id: 'h2',
        dedupeKey: 'acme|engineer|b',
        posting: { company: 'Acme', title: 'Engineer', postingUrl: null, location: 'Remote' },
      }),
    ];
    const [group] = groupResults(hostileMembers);
    const { container } = render(
      <ul>
        <QueueGroupRow
          group={group!}
          selected={false}
          onSelect={vi.fn()}
          onAcceptAll={vi.fn()}
          onDismissAll={vi.fn()}
          onOpen={vi.fn()}
        />
      </ul>,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container).toHaveTextContent(HOSTILE);
  });
});

describe('ReviewQueue', () => {
  const A = result({
    id: 'r-a',
    aiScore: 91,
    posting: { company: 'Acme', title: 'Platform Lead' },
  });
  const B = result({ id: 'r-b', aiScore: 60, posting: { company: 'Globex', title: 'Staff SRE' } });

  it('requests pending results best score first', async () => {
    const { calls } = mockApi({ 'GET /discovery/results': { items: [A, B], total: 2 } });
    renderWithProviders(<ReviewQueue />);
    expect(await screen.findByText('Platform Lead')).toBeInTheDocument();
    const get = calls.find((c) => c.path === '/discovery/results');
    const params = new URLSearchParams(get?.search);
    expect(params.get('disposition')).toBe('pending');
    expect(params.get('sort')).toBe('-ai_score');
  });

  it('keyboard: j selects, i accepts through the accept endpoint', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /discovery/results': { items: [A, B], total: 2 },
      'POST /discovery/results/r-b/accept': { ...B, disposition: 'accepted', opportunityId: 'o-1' },
    });
    renderWithProviders(<ReviewQueue />);
    await screen.findByText('Platform Lead');
    await user.keyboard('jj');
    expect(screen.getByRole('listitem', { name: /Staff SRE/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await user.keyboard('i');
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST');
      expect(post?.path).toBe('/discovery/results/r-b/accept');
      expect(post?.body).toEqual({});
    });
  });

  it('keyboard: x opens the dismiss dialog and sends the chosen reason', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /discovery/results': { items: [A], total: 1 },
      'POST /discovery/results/r-a/dismiss': { ...A, disposition: 'dismissed' },
    });
    renderWithProviders(<ReviewQueue />);
    await screen.findByText('Platform Lead');
    await user.keyboard('jx');
    const dialog = await screen.findByRole('dialog', { name: 'Dismiss result' });
    // Triage keys are inert while a dialog is open.
    await user.keyboard('i');
    expect(calls.some((c) => c.path.endsWith('/accept'))).toBe(false);
    await user.selectOptions(within(dialog).getByLabelText('Reason'), 'seniority');
    await user.click(within(dialog).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => {
      const post = calls.find((c) => c.path === '/discovery/results/r-a/dismiss');
      expect(post?.body).toEqual({ reason: 'seniority' });
    });
  });

  it('keys typed in an input never trigger triage', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ 'GET /discovery/results': { items: [A], total: 1 } });
    renderWithProviders(
      <>
        <input aria-label="elsewhere" />
        <ReviewQueue />
      </>,
    );
    await screen.findByText('Platform Lead');
    await user.click(screen.getByLabelText('elsewhere'));
    await user.keyboard('ji');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('a 409 duplicate opens the attach dialog; Attach to existing posts attachTo', async () => {
    const user = userEvent.setup();
    const accepts: unknown[] = [];
    mockApi({
      'GET /discovery/results': { items: [A], total: 1 },
      'POST /discovery/results/r-a/accept': (call: { body: unknown }) => {
        accepts.push(call.body);
        if (accepts.length === 1) {
          return {
            status: 409,
            body: { error: { code: 'duplicate', message: 'duplicate', existingId: 'opp-9' } },
          };
        }
        return { ...A, disposition: 'accepted', opportunityId: 'opp-9' };
      },
    });
    renderWithProviders(<ReviewQueue />);
    await screen.findByText('Platform Lead');
    await user.keyboard('ji');
    const dialog = await screen.findByRole('dialog', { name: 'Already in your pipeline?' });
    expect(
      within(dialog).getByRole('link', { name: 'View the existing opportunity' }),
    ).toHaveAttribute('href', '/opportunities/opp-9');
    expect(within(dialog).getByRole('button', { name: 'Create anyway' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Attach to existing' }));
    await waitFor(() => expect(accepts).toEqual([{}, { attachTo: 'opp-9' }]));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Already in your pipeline?' })).toBeNull(),
    );
  });

  it('Create anyway retries the accept with force', async () => {
    const user = userEvent.setup();
    const accepts: unknown[] = [];
    mockApi({
      'GET /discovery/results': { items: [A], total: 1 },
      'POST /discovery/results/r-a/accept': (call: { body: unknown }) => {
        accepts.push(call.body);
        return accepts.length === 1
          ? { status: 409, body: { error: { code: 'duplicate', existingId: 'opp-9' } } }
          : { ...A, disposition: 'accepted', opportunityId: 'opp-10' };
      },
    });
    renderWithProviders(<ReviewQueue />);
    await screen.findByText('Platform Lead');
    await user.click(screen.getByRole('button', { name: 'Accept Platform Lead at Acme' }));
    const dialog = await screen.findByRole('dialog', { name: 'Already in your pipeline?' });
    await user.click(within(dialog).getByRole('button', { name: 'Create anyway' }));
    await waitFor(() => expect(accepts).toEqual([{}, { force: true }]));
  });

  it('keyboard: p opens the posting in a new tab, distinct from Enter opening the details', async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const withUrl = result({
      id: 'r-url',
      posting: {
        company: 'Acme',
        title: 'Platform Lead',
        postingUrl: 'https://boards.greenhouse.io/initech/jobs/1',
      },
    });
    mockApi({ 'GET /discovery/results': { items: [withUrl], total: 1 } });
    renderWithProviders(<ReviewQueue />);
    await screen.findByText('Platform Lead');
    await user.keyboard('jp');
    expect(openSpy).toHaveBeenCalledWith(
      'https://boards.greenhouse.io/initech/jobs/1',
      '_blank',
      'noopener,noreferrer',
    );
    // p did not also open the in-app detail dialog.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    openSpy.mockRestore();
  });

  it('p does nothing for a result with no posting URL', async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const noUrl = result({
      id: 'r-no-url',
      posting: { company: 'Acme', title: 'No Link', postingUrl: null },
    });
    mockApi({ 'GET /discovery/results': { items: [noUrl], total: 1 } });
    renderWithProviders(<ReviewQueue />);
    await screen.findByText('No Link');
    await user.keyboard('jp');
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('the legend names Enter and p for the two different things they open', async () => {
    mockApi({ 'GET /discovery/results': { items: [A], total: 1 } });
    renderWithProviders(<ReviewQueue />);
    await screen.findByText('Platform Lead');
    // The legend's text is split across <kbd> elements, so match on the <p>'s full textContent
    // rather than the default per-node matcher.
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === 'P' && /p posting, Enter details/.test(element.textContent ?? ''),
      ),
    ).toBeInTheDocument();
  });

  it('Enter opens the detail dialog with the full posting as text', async () => {
    const user = userEvent.setup();
    const hostile = result({
      id: 'r-h',
      posting: { company: 'Acme', title: 'Lead', descriptionMd: `Line one\n${HOSTILE}` },
    });
    mockApi({ 'GET /discovery/results': { items: [hostile], total: 1 } });
    renderWithProviders(<ReviewQueue />);
    await screen.findByText('Lead');
    await user.keyboard('j{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Lead' });
    expect(dialog).toHaveTextContent(HOSTILE);
    expect(dialog.querySelector('script, img')).toBeNull();
  });

  describe('location groups (issue #191)', () => {
    const ca = result({
      id: 'r-ca',
      aiScore: 90,
      dedupeKey: 'vandelay|technical product manager enterprise products|california',
      posting: { company: 'VANDELAY', title: 'Technical Product Manager - Enterprise Products' },
    });
    const co = result({
      id: 'r-co',
      aiScore: 85,
      dedupeKey: 'vandelay|technical product manager enterprise products|colorado',
      posting: { company: 'VANDELAY', title: 'Technical Product Manager - Enterprise Products' },
    });
    const nc = result({
      id: 'r-nc',
      aiScore: 80,
      dedupeKey: 'vandelay|technical product manager enterprise products|north carolina',
      posting: { company: 'VANDELAY', title: 'Technical Product Manager - Enterprise Products' },
    });

    it('renders three same-role, different-location results as one group, not three rows', async () => {
      mockApi({ 'GET /discovery/results': { items: [ca, co, nc], total: 3 } });
      renderWithProviders(<ReviewQueue />);
      expect(await screen.findByRole('button', { name: /^Accept all 3/ })).toBeInTheDocument();
      expect(
        screen.getAllByRole('listitem').filter((li) => li.hasAttribute('data-result-id')),
      ).toHaveLength(1);
    });

    it('a location group offers no checkbox at all (issue #209: not safely selectable for bulk triage)', async () => {
      const solo = result({
        id: 'r-solo',
        aiScore: 50,
        posting: { company: 'Acme', title: 'Engineer' },
      });
      mockApi({ 'GET /discovery/results': { items: [ca, co, nc, solo], total: 4 } });
      renderWithProviders(<ReviewQueue />);
      await screen.findByRole('button', { name: /^Accept all 3/ });
      // Exactly one checkbox: the singleton row's. The group has none.
      expect(screen.getAllByRole('checkbox')).toHaveLength(1);
      expect(screen.getByRole('checkbox', { name: /Select Engineer at Acme/ })).toBeInTheDocument();
    });

    it('"Select all N loaded" counts and checks only ungrouped rows, never a group\'s members', async () => {
      const user = userEvent.setup();
      const solo = result({
        id: 'r-solo',
        aiScore: 50,
        posting: { company: 'Acme', title: 'Engineer' },
      });
      mockApi({ 'GET /discovery/results': { items: [ca, co, nc, solo], total: 4 } });
      renderWithProviders(<ReviewQueue />);
      const button = await screen.findByRole('button', { name: 'Select all 1 loaded' });
      await user.click(button);
      expect(screen.getByText('1 selected')).toBeInTheDocument();
    });

    it('accepting a group accepts the best-scoring location, then attaches every other one to the same opportunity', async () => {
      const user = userEvent.setup();
      const accepts: { id: string; body: unknown }[] = [];
      mockApi({
        'GET /discovery/results': { items: [ca, co, nc], total: 3 },
        'POST /discovery/results/r-ca/accept': (call: { body: unknown }) => {
          accepts.push({ id: 'r-ca', body: call.body });
          return { ...ca, disposition: 'accepted', opportunityId: 'opp-vandelay' };
        },
        'POST /discovery/results/r-co/accept': (call: { body: unknown }) => {
          accepts.push({ id: 'r-co', body: call.body });
          return { ...co, disposition: 'accepted', opportunityId: 'opp-vandelay' };
        },
        'POST /discovery/results/r-nc/accept': (call: { body: unknown }) => {
          accepts.push({ id: 'r-nc', body: call.body });
          return { ...nc, disposition: 'accepted', opportunityId: 'opp-vandelay' };
        },
      });
      renderWithProviders(<ReviewQueue />);
      await user.click(await screen.findByRole('button', { name: /^Accept all 3/ }));
      await waitFor(() => expect(accepts).toHaveLength(3));
      expect(accepts[0]).toEqual({ id: 'r-ca', body: {} });
      // Order-independent: the two attaches race via Promise.all, but both must carry attachTo.
      expect(accepts.slice(1).map((a) => a.body)).toEqual([
        { attachTo: 'opp-vandelay' },
        { attachTo: 'opp-vandelay' },
      ]);
      // getAllByText + the last match: the toast store is a module-level singleton that keeps
      // up to 3 toasts across the whole test file, so an earlier test's identical-text toast
      // can still be mounted when this one fires.
      await waitFor(() =>
        expect(screen.getAllByText('Added to pipeline (3 locations)').length).toBeGreaterThan(0),
      );
    });

    it("a 409 on the group's primary location still attaches the other locations once resolved", async () => {
      const user = userEvent.setup();
      const decided = new Set<string>();
      const primaryAttempts: unknown[] = [];
      const attached: string[] = [];
      mockApi({
        'GET /discovery/results': () => ({
          items: [ca, co, nc].filter((r) => !decided.has(r.id)),
          total: 3 - decided.size,
        }),
        'POST /discovery/results/r-ca/accept': (call: { body: unknown }) => {
          primaryAttempts.push(call.body);
          if (primaryAttempts.length === 1) {
            return {
              status: 409,
              body: { error: { code: 'duplicate', message: 'duplicate', existingId: 'opp-9' } },
            };
          }
          decided.add('r-ca');
          return { ...ca, disposition: 'accepted', opportunityId: 'opp-9' };
        },
        'POST /discovery/results/r-co/accept': () => {
          decided.add('r-co');
          attached.push('r-co');
          return { ...co, disposition: 'accepted', opportunityId: 'opp-9' };
        },
        'POST /discovery/results/r-nc/accept': () => {
          decided.add('r-nc');
          attached.push('r-nc');
          return { ...nc, disposition: 'accepted', opportunityId: 'opp-9' };
        },
      });
      renderWithProviders(<ReviewQueue />);
      await user.click(await screen.findByRole('button', { name: /^Accept all 3/ }));
      const dialog = await screen.findByRole('dialog', { name: 'Already in your pipeline?' });
      await user.click(within(dialog).getByRole('button', { name: 'Attach to existing' }));
      await waitFor(() => expect(attached.sort()).toEqual(['r-co', 'r-nc']));
      // See the sibling test above: the toast store keeps up to 3 toasts across the whole
      // file, so this only confirms the toast fired, not that it is the sole one shown.
      await waitFor(() =>
        expect(screen.getAllByText('Added to pipeline (3 locations)').length).toBeGreaterThan(0),
      );
    });

    it('dismissing a group records the same reason for every location and reports the group count', async () => {
      const user = userEvent.setup();
      const dismissed: string[] = [];
      mockApi({
        'GET /discovery/results': { items: [ca, co, nc], total: 3 },
        'POST /discovery/results/r-ca/dismiss': (call: { body: unknown }) => {
          dismissed.push('r-ca');
          expect(call.body).toEqual({ reason: 'seniority' });
          return { ...ca, disposition: 'dismissed' };
        },
        'POST /discovery/results/r-co/dismiss': (call: { body: unknown }) => {
          dismissed.push('r-co');
          expect(call.body).toEqual({ reason: 'seniority' });
          return { ...co, disposition: 'dismissed' };
        },
        'POST /discovery/results/r-nc/dismiss': (call: { body: unknown }) => {
          dismissed.push('r-nc');
          expect(call.body).toEqual({ reason: 'seniority' });
          return { ...nc, disposition: 'dismissed' };
        },
      });
      renderWithProviders(<ReviewQueue />);
      await user.click(await screen.findByRole('button', { name: /^Dismiss all 3/ }));
      const dialog = await screen.findByRole('dialog', { name: 'Dismiss result' });
      expect(dialog).toHaveTextContent('2 other locations for this role');
      await user.selectOptions(within(dialog).getByLabelText('Reason'), 'seniority');
      await user.click(within(dialog).getByRole('button', { name: 'Dismiss' }));
      await waitFor(() => expect(dismissed.sort()).toEqual(['r-ca', 'r-co', 'r-nc']));
      expect(await screen.findByText('Dismissed (3 locations)')).toBeInTheDocument();
    });

    it("the detail dialog's accept acts on just the one location opened, not its whole group", async () => {
      const user = userEvent.setup();
      const accepted: string[] = [];
      mockApi({
        'GET /discovery/results': () => ({
          items: [ca, co, nc].filter((r) => !accepted.includes(r.id)),
          total: 3 - accepted.length,
        }),
        'POST /discovery/results/r-ca/accept': () => {
          accepted.push('r-ca');
          return { ...ca, disposition: 'accepted', opportunityId: 'opp-1' };
        },
      });
      renderWithProviders(<ReviewQueue />);
      const title = await screen.findByRole('button', {
        name: 'Technical Product Manager - Enterprise Products',
      });
      await user.click(title);
      const dialog = await screen.findByRole('dialog', {
        name: 'Technical Product Manager - Enterprise Products',
      });
      await user.click(within(dialog).getByRole('button', { name: /^Accept/ }));
      await waitFor(() => expect(accepted).toEqual(['r-ca']));
      // Only the one result left the queue; the group's other two locations are still there.
      expect(await screen.findByRole('button', { name: /^Accept all 2/ })).toBeInTheDocument();
    });

    it('Shift+J moving the cursor onto a group adds nothing to the checked range, and resumes correctly past it', async () => {
      const user = userEvent.setup();
      const before = result({
        id: 'r-before',
        aiScore: 95,
        posting: { company: 'Acme', title: 'Before' },
      });
      const after = result({
        id: 'r-after',
        aiScore: 10,
        posting: { company: 'Acme', title: 'After' },
      });
      // Order: before (singleton), the VANDELAY group, after (singleton).
      mockApi({ 'GET /discovery/results': { items: [before, ca, co, nc, after], total: 5 } });
      renderWithProviders(<ReviewQueue />);
      await screen.findByText('Before');
      // j selects "Before"; Shift+J moves onto the group (nothing to check there); a second
      // Shift+J moves onto "After" and must still extend from "Before", not lose the anchor.
      await user.keyboard('j{Shift>}JJ{/Shift}');
      expect(screen.getByText('2 selected')).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: /Select Before at Acme/ })).toBeChecked();
      expect(screen.getByRole('checkbox', { name: /Select After at Acme/ })).toBeChecked();
    });
  });
});

describe('ReviewQueue bulk triage (#184)', () => {
  const X = result({ id: 'r-x', aiScore: 90, posting: { company: 'Initech', title: 'One' } });
  const Y = result({ id: 'r-y', aiScore: 80, posting: { company: 'Initech', title: 'Two' } });
  const Z = result({ id: 'r-z', aiScore: 70, posting: { company: 'Initech', title: 'Three' } });

  it('checking a row shows the action bar with a count; Clear empties it', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /discovery/results': { items: [X, Y], total: 2 } });
    renderWithProviders(<ReviewQueue />);
    await screen.findByText('One');
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Select One at Initech' }));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
  });

  it('shift-clicking a checkbox range-selects every row in between', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /discovery/results': { items: [X, Y, Z], total: 3 } });
    renderWithProviders(<ReviewQueue />);
    await screen.findByText('One');
    await user.click(screen.getByRole('checkbox', { name: 'Select One at Initech' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Three at Initech' }), {
      shiftKey: true,
    });
    expect(screen.getByText('3 selected')).toBeInTheDocument();
    for (const name of ['One', 'Two', 'Three']) {
      expect(screen.getByRole('checkbox', { name: `Select ${name} at Initech` })).toBeChecked();
    }
  });

  it('"Select all N loaded" checks everything rendered', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /discovery/results': { items: [X, Y, Z], total: 3 } });
    renderWithProviders(<ReviewQueue />);
    await screen.findByText('One');
    await user.click(screen.getByRole('button', { name: 'Select all 3 loaded' }));
    expect(screen.getByText('3 selected')).toBeInTheDocument();
  });

  it('fetchAllPendingResultIds paginates past a full first page of 200', async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => result({ id: `p-${i}` }));
    const { calls } = mockApi({
      'GET /discovery/results': (call: { search: string }) => {
        const offset = new URLSearchParams(call.search).get('offset') ?? '0';
        return offset === '0'
          ? { items: page1, total: 201 }
          : { items: [result({ id: 'p-200' })], total: 201 };
      },
    });
    const ids = await fetchAllPendingResultIds();
    expect(ids).toHaveLength(201);
    expect(ids.at(-1)).toBe('p-200');
    expect(calls.filter((c) => c.path === '/discovery/results')).toHaveLength(2);
  });

  it('"Select all N matching" appears only when more exist than are loaded, and checks all of it', async () => {
    const user = userEvent.setup();
    const page1 = Array.from({ length: 200 }, (_, i) => result({ id: `p-${i}` }));
    mockApi({
      'GET /discovery/results': (call: { search: string }) => {
        const offset = new URLSearchParams(call.search).get('offset') ?? '0';
        return offset === '0'
          ? { items: page1, total: 201 }
          : { items: [result({ id: 'p-200' })], total: 201 };
      },
    });
    renderWithProviders(<ReviewQueue />);
    await screen.findByText('Select all 200 loaded');
    await user.click(screen.getByRole('button', { name: 'Select all 201 matching' }));
    await waitFor(() => expect(screen.getByText('201 selected')).toBeInTheDocument());
  });

  it('space toggles the keyboard cursor row, Escape clears the whole selection', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /discovery/results': { items: [X, Y], total: 2 } });
    renderWithProviders(<ReviewQueue />);
    await screen.findByText('One');
    await user.keyboard('j ');
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select One at Initech' })).toBeChecked();
    await user.keyboard('{Escape}');
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
  });

  it('Shift+J extends the checked range while moving the cursor down', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /discovery/results': { items: [X, Y, Z], total: 3 } });
    renderWithProviders(<ReviewQueue />);
    await screen.findByText('One');
    await user.keyboard('j{Shift>}JJ{/Shift}');
    expect(screen.getByText('3 selected')).toBeInTheDocument();
  });

  it('bulk accept confirms, posts the checked ids, and reports a per-item summary', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /discovery/results': { items: [X, Y], total: 2 },
      'POST /discovery/results/bulk-accept': {
        results: [
          { id: 'r-x', outcome: 'accepted' },
          { id: 'r-y', outcome: 'duplicate', existingId: 'opp-1' },
        ],
      },
    });
    renderWithProviders(<ReviewQueue />);
    await screen.findByText('One');
    await user.click(screen.getByRole('button', { name: 'Select all 2 loaded' }));
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    const dialog = await screen.findByRole('dialog', { name: 'Accept 2 results?' });
    await user.click(within(dialog).getByRole('button', { name: 'Accept 2' }));
    await waitFor(() => {
      const post = calls.find((c) => c.path === '/discovery/results/bulk-accept');
      expect(post?.body).toEqual({ ids: ['r-x', 'r-y'] });
    });
    expect(await screen.findByText('1 accepted; 1 already tracked')).toBeInTheDocument();
    // The batch is fully resolved either way, so the selection clears.
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it('bulk dismiss defaults to "not interested" but can be changed, e.g. to "duplicate" (#191)', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /discovery/results': { items: [X, Y], total: 2 },
      'POST /discovery/results/bulk-dismiss': {
        results: [
          { id: 'r-x', outcome: 'dismissed' },
          { id: 'r-y', outcome: 'dismissed' },
        ],
      },
    });
    renderWithProviders(<ReviewQueue />);
    await screen.findByText('One');
    await user.click(screen.getByRole('button', { name: 'Select all 2 loaded' }));
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dismiss 2 results' });
    expect(within(dialog).getByLabelText('Reason')).toHaveValue('not_interested');
    await user.selectOptions(within(dialog).getByLabelText('Reason'), 'duplicate');
    await user.click(within(dialog).getByRole('button', { name: 'Dismiss 2' }));
    await waitFor(() => {
      const post = calls.find((c) => c.path === '/discovery/results/bulk-dismiss');
      expect(post?.body).toEqual({ ids: ['r-x', 'r-y'], reason: 'duplicate' });
    });
    expect(await screen.findByText('2 dismissed')).toBeInTheDocument();
  });

  it('bulk dismiss offers Undo, which posts the dismissed ids to bulk-undo-dismiss', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /discovery/results': { items: [X], total: 1 },
      'POST /discovery/results/bulk-dismiss': {
        results: [{ id: 'r-x', outcome: 'dismissed' }],
      },
      'POST /discovery/results/bulk-undo-dismiss': {
        results: [{ id: 'r-x', outcome: 'restored' }],
      },
    });
    renderWithProviders(<ReviewQueue />);
    await screen.findByText('One');
    await user.click(screen.getByRole('button', { name: 'Select all 1 loaded' }));
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dismiss 1 results' });
    await user.click(within(dialog).getByRole('button', { name: 'Dismiss 1' }));
    await screen.findByText('1 dismissed');
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      const post = calls.find((c) => c.path === '/discovery/results/bulk-undo-dismiss');
      expect(post?.body).toEqual({ ids: ['r-x'] });
    });
    expect(await screen.findByText('1 restored')).toBeInTheDocument();
  });

  it('a batch over MAX_BULK_SIZE is split into sequential requests', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `id-${i}`);
    const items = ids.map((id, i) =>
      result({ id, aiScore: 100 - i, posting: { company: 'C', title: id } }),
    );
    const { calls } = mockApi({
      'GET /discovery/results': { items, total: items.length },
      'POST /discovery/results/bulk-accept': (call: { body: { ids: string[] } }) => ({
        results: call.body.ids.map((id) => ({ id, outcome: 'accepted' })),
      }),
    });
    const user = userEvent.setup();
    renderWithProviders(<ReviewQueue />);
    await screen.findByText(ids[0]!);
    await user.click(screen.getByRole('button', { name: `Select all ${items.length} loaded` }));
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    const dialog = await screen.findByRole('dialog', { name: `Accept ${items.length} results?` });
    await user.click(within(dialog).getByRole('button', { name: `Accept ${items.length}` }));
    await waitFor(() => {
      const posts = calls.filter((c) => c.path === '/discovery/results/bulk-accept');
      expect(posts).toHaveLength(2);
      expect((posts[0]!.body as { ids: string[] }).ids).toHaveLength(100);
      expect((posts[1]!.body as { ids: string[] }).ids).toHaveLength(50);
    });
    expect(await screen.findByText('150 accepted')).toBeInTheDocument();
  });

  it('shows visible progress through a chunked batch, not a silent wait (#184)', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `id-${i}`);
    const items = ids.map((id, i) =>
      result({ id, aiScore: 100 - i, posting: { company: 'C', title: id } }),
    );
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let callCount = 0;
    mockApi({
      'GET /discovery/results': { items, total: items.length },
      'POST /discovery/results/bulk-accept': async (call: { body: { ids: string[] } }) => {
        callCount += 1;
        if (callCount === 1) await firstGate;
        if (callCount === 2) await secondGate;
        return { results: call.body.ids.map((id) => ({ id, outcome: 'accepted' as const })) };
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<ReviewQueue />);
    await screen.findByText(ids[0]!);
    await user.click(screen.getByRole('button', { name: `Select all ${items.length} loaded` }));
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    const dialog = await screen.findByRole('dialog', { name: `Accept ${items.length} results?` });
    await user.click(within(dialog).getByRole('button', { name: `Accept ${items.length}` }));
    // First chunk (100 ids) not back yet: busy, but nothing to report progress on yet.
    expect(await within(dialog).findByRole('button', { name: 'Accepting…' })).toBeInTheDocument();
    releaseFirst?.();
    // First chunk back, second (50 ids) still gated: progress reads 100/150, not silent.
    expect(
      await within(dialog).findByRole('button', { name: 'Accepting 100/150…' }),
    ).toBeInTheDocument();
    releaseSecond?.();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('150 accepted')).toBeInTheDocument();
  });
});
