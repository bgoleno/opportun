// Find posting (Task 6, FR-O1): the Description card offers to look the posting up, one
// confident match lands without a dialog, several open the picker, and a company with no board
// falls back to pasting. Candidate text from a board is rendered as text, never as markup.
import { sha256Hex } from '@opportun/core';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { qk, type OpportunityView } from '@/lib/opportunities';
import { browserCloses, pressEscapeOn } from '@/test/dialog';
import { mockApi, renderWithProviders, toastRegion, type ApiCall } from '@/test/render';
import { useOpportunity } from './api';
import { DetailsPanel } from './DetailsPanel';

const NOW = Date.now();

const BARE = {
  id: 'opp-1',
  userId: 'u1',
  companyId: 'c1',
  companyName: 'Sentinel Edge',
  title: 'Product Manager, SIEM',
  stage: 'in_process',
  sourceKind: 'import',
  priority: 2,
  descriptionMd: null,
  postingUrl: null,
  location: null,
  remote: null,
  compNote: null,
  createdAt: NOW,
  updatedAt: NOW,
} as unknown as OpportunityView;

const CANDIDATE = (title: string, location: string, id: string) => ({
  posting: {
    company: 'Sentinel Edge',
    title,
    descriptionMd: `What We Do: ${title}.`,
    postingUrl: `https://job-boards.greenhouse.io/sentineledge/jobs/${id}`,
    location,
    remote: null,
    compNote: null,
    externalId: id,
    postedAt: null,
  },
  score: 0.75,
  otherLocations: [],
});

const PARTLY = 'Large Workday board: showing the first 200 of 500 postings.';

const NO_ATTACHMENTS = { items: [], total: 0 };

function setup(routes: Record<string, unknown>) {
  const api = mockApi({
    'GET /opportunities/opp-1/attachments': NO_ATTACHMENTS,
    ...routes,
  });
  return api;
}

describe('Find posting', () => {
  // #756 (tl): offered until the posting is confirmed, a described one included, since Find
  // posting is what confirms it; a confirmed posting with a description has nothing to find.
  it('offers Find posting while the description is empty or the posting is not confirmed', async () => {
    setup({});
    const { unmount } = renderWithProviders(<DetailsPanel opp={BARE} />);
    expect(await screen.findByRole('button', { name: /find posting/i })).toBeInTheDocument();
    unmount();

    setup({});
    const described = renderWithProviders(
      <DetailsPanel opp={{ ...BARE, descriptionMd: 'my own notes', postingState: null }} />,
    );
    expect(await screen.findByText('my own notes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /find posting/i })).toBeInTheDocument();
    described.unmount();

    setup({});
    renderWithProviders(
      <DetailsPanel opp={{ ...BARE, descriptionMd: 'already here', postingState: 'confirmed' }} />,
    );
    expect(await screen.findByText('already here')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /find posting/i })).not.toBeInTheDocument();
  });

  // #852 (qa; tl on #865): while a background check is reading the board, the server refuses a
  // second search, and the panel says why. The button stays enabled: a 'searching' left by a
  // check that died must not take Find posting away, and the server knows which it is.
  it('a Find posting refused while a check runs says why (#852)', async () => {
    setup({
      'POST /opportunities/opp-1/find-posting': () => ({
        status: 409,
        body: { error: { code: 'posting_searching' } },
      }),
    });
    renderWithProviders(<DetailsPanel opp={{ ...BARE, postingState: 'searching' }} />);
    const button = await screen.findByRole('button', { name: /find posting/i });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(await screen.findByText(/still checking this posting/i)).toBeInTheDocument();
  });

  /** DetailsPanel on the opportunity as the server has it, as the page shows it. */
  function Live() {
    const { data } = useOpportunity('opp-1');
    return data === undefined ? null : <DetailsPanel opp={data} />;
  }

  // #870 (em, qa on #865): the refusal is about a check under way, so it goes when that ends.
  it.each(['confirmed', 'needs_review', null] as const)(
    'a refusal for a running check goes when the check ends, the state then %s (#870)',
    async (ended) => {
      let now = { ...BARE, postingState: 'searching' } as OpportunityView;
      setup({
        'GET /opportunities/opp-1': () => now,
        'POST /opportunities/opp-1/find-posting': () => ({
          status: 409,
          body: { error: { code: 'posting_searching' } },
        }),
      });
      const { queryClient } = renderWithProviders(<Live />);
      await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));
      expect(await screen.findByRole('alert')).toHaveTextContent(/still checking this posting/i);

      // Read again while the check still runs: still true, so it stays.
      await act(() => queryClient.invalidateQueries({ queryKey: qk.opportunity('opp-1') }));
      expect(screen.getByRole('alert')).toHaveTextContent(/still checking this posting/i);

      now = { ...BARE, postingState: ended } as OpportunityView;
      await act(() => queryClient.invalidateQueries({ queryKey: qk.opportunity('opp-1') }));
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    },
  );

  // The page had not heard of the check: the refusal's own refresh brings 'searching', and the
  // check can end where it began. Kept through the first, gone after the second.
  it('a refusal on a stale page stays while the check runs, and goes when it ends (#870)', async () => {
    const before = { ...BARE, postingState: 'needs_review' } as OpportunityView;
    let now = before;
    setup({
      'GET /opportunities/opp-1': () => now,
      'POST /opportunities/opp-1/find-posting': () => {
        now = { ...before, postingState: 'searching' } as OpportunityView;
        return { status: 409, body: { error: { code: 'posting_searching' } } };
      },
    });
    const { queryClient } = renderWithProviders(<Live />);
    await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/still checking this posting/i);

    now = before;
    await act(() => queryClient.invalidateQueries({ queryKey: qk.opportunity('opp-1') }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  // The refusal's own refresh can already bring the check's result, before the refusal is shown.
  it('a refusal that arrives after the check ended is not shown (#870)', async () => {
    let now = { ...BARE, postingState: 'searching' } as OpportunityView;
    setup({
      'GET /opportunities/opp-1': () => now,
      'POST /opportunities/opp-1/find-posting': () => {
        now = { ...BARE, postingState: 'confirmed' } as OpportunityView;
        return { status: 409, body: { error: { code: 'posting_searching' } } };
      },
    });
    renderWithProviders(<Live />);
    const button = await screen.findByRole('button', { name: /find posting/i });
    await userEvent.click(button);
    await waitFor(() => expect(button).toBeEnabled());
    expect(await screen.findByText(/matched on the company's board/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // tl and qa on #885: the check ended, in the state the page already showed, before the refusal's
  // own refresh read it, so the page saw no change. The refresh itself says the check is over.
  it('a check that ended unseen, in the same state, leaves no refusal, and it is said (#866)', async () => {
    const opp = {
      ...BARE,
      postingState: 'needs_review',
      postingStateDetail: 'none_found',
    } as OpportunityView;
    const api = setup({
      'GET /opportunities/opp-1': opp,
      'POST /opportunities/opp-1/find-posting': () => ({
        status: 409,
        body: { error: { code: 'posting_searching' } },
      }),
    });
    renderWithProviders(<Live />);
    await userEvent.click(await screen.findByRole('button', { name: 'Find posting' }));
    expect(await toastRegion().findByText('Check ended')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/still checking this posting/i)).toBeNull();
    expect(
      api.calls.filter((c: ApiCall) => c.method === 'GET' && c.path === '/opportunities/opp-1'),
    ).toHaveLength(2);
  });

  // A check can also end because its job died (#869): the toast must not say it finished, above a
  // notice that says it did not.
  it('a check that died unseen is said to have ended, not finished (#866)', async () => {
    setup({
      'GET /opportunities/opp-1': {
        ...BARE,
        postingState: 'needs_review',
        postingStateDetail: 'failed',
      } as OpportunityView,
      'POST /opportunities/opp-1/find-posting': () => ({
        status: 409,
        body: { error: { code: 'posting_searching' } },
      }),
    });
    renderWithProviders(<Live />);
    await userEvent.click(await screen.findByRole('button', { name: 'Find posting' }));
    expect(await toastRegion().findByText('Check ended')).toBeInTheDocument();
    expect(toastRegion().queryByText(/finished/i)).toBeNull();
    expect(screen.getByText(/did not finish/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // The refresh failed: nothing says the check is over, so the refusal stands.
  it('a refusal whose refresh fails is shown (#866)', async () => {
    const opp = { ...BARE, postingState: 'needs_review' } as OpportunityView;
    let refused = false;
    setup({
      'GET /opportunities/opp-1': () =>
        refused ? { status: 500, body: { error: { code: 'internal' } } } : opp,
      'POST /opportunities/opp-1/find-posting': () => {
        refused = true;
        return { status: 409, body: { error: { code: 'posting_searching' } } };
      },
    });
    renderWithProviders(<Live />);
    await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/still checking this posting/i);
  });

  // #936: the job is the user's already, as another opportunity.
  describe('a job already tracked (#936)', () => {
    const refused = (details: Record<string, unknown>) => ({
      status: 409,
      body: { error: { code: 'duplicate', ...details } },
    });
    const NAMED = {
      existingId: 'opp-9',
      existingTitle: 'Product Manager, SIEM',
      existingCompany: 'Sentinel Edge',
    };

    it('Find posting says so, and links to the opportunity', async () => {
      setup({ 'POST /opportunities/opp-1/find-posting': () => refused(NAMED) });
      renderWithProviders(<DetailsPanel opp={BARE} />);
      await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(
        'This job is already tracked as Product Manager, SIEM at Sentinel Edge.',
      );
      expect(
        within(alert).getByRole('link', { name: 'Product Manager, SIEM at Sentinel Edge' }),
      ).toHaveAttribute('href', '/opportunities/opp-9');
      expect(screen.queryByText(/already exists/i)).toBeNull();
    });

    it('a row picked in the dialog says so too', async () => {
      setup({
        'POST /opportunities/opp-1/find-posting': {
          outcome: 'candidates',
          candidates: [CANDIDATE('Staff Product Manager, SIEM', 'United States', '1')],
          board: [CANDIDATE('Staff Product Manager, SIEM', 'United States', '1')],
        },
        'POST /opportunities/opp-1/posting': () => refused(NAMED),
      });
      renderWithProviders(<DetailsPanel opp={BARE} />);
      await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));
      const dialog = await screen.findByRole('dialog');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Attach' }));
      const alert = await within(dialog).findByRole('alert');
      expect(
        within(alert).getByRole('link', { name: 'Product Manager, SIEM at Sentinel Edge' }),
      ).toHaveAttribute('href', '/opportunities/opp-9');
    });

    // An older server, or one that lost it meanwhile, names the id alone.
    it('with no name, it still says so and links', async () => {
      setup({
        'POST /opportunities/opp-1/find-posting': () => refused({ existingId: 'opp-9' }),
      });
      renderWithProviders(<DetailsPanel opp={BARE} />);
      await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('This job is already tracked as another opportunity.');
      expect(within(alert).getByRole('link', { name: 'another opportunity' })).toHaveAttribute(
        'href',
        '/opportunities/opp-9',
      );
    });

    it('with nothing to link to, the shared sentence', async () => {
      setup({ 'POST /opportunities/opp-1/find-posting': () => refused({}) });
      renderWithProviders(<DetailsPanel opp={BARE} />);
      await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));
      expect(await screen.findByRole('alert')).toHaveTextContent('That already exists.');
    });

    it('markup in the name is shown as text', async () => {
      setup({
        'POST /opportunities/opp-1/find-posting': () =>
          refused({ ...NAMED, existingTitle: '<img src=x onerror=alert(1)>' }),
      });
      renderWithProviders(<DetailsPanel opp={BARE} />);
      await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('<img src=x onerror=alert(1)> at Sentinel Edge');
      expect(alert.querySelector('img')).toBeNull();
    });
  });

  // Any other failure is not about a check, so a change of state does not take it away.
  it('another error stays when the posting state changes (#870)', async () => {
    let now = { ...BARE, postingState: 'needs_review' } as OpportunityView;
    setup({
      'GET /opportunities/opp-1': () => now,
      'POST /opportunities/opp-1/find-posting': () => ({
        status: 502,
        body: { error: { code: 'upstream_unavailable', message: 'The board did not answer.' } },
      }),
    });
    const { queryClient } = renderWithProviders(<Live />);
    await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The board did not answer.');
    now = { ...BARE, postingState: null } as OpportunityView;
    await act(() => queryClient.invalidateQueries({ queryKey: qk.opportunity('opp-1') }));
    expect(screen.getByRole('alert')).toHaveTextContent('The board did not answer.');
  });

  // qa on #865: a click as a background check ends. The click says what state the page saw, and
  // a posting confirmed since is answered as it is, said so, with nothing attached again.
  it('a click says the state it saw, and a posting confirmed meanwhile is said so (#852)', async () => {
    const api = setup({
      'POST /opportunities/opp-1/find-posting': {
        outcome: 'already_confirmed',
        opportunity: { ...BARE, postingState: 'confirmed' },
      },
    });
    renderWithProviders(<DetailsPanel opp={{ ...BARE, postingState: 'searching' }} />);
    await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));
    expect(await screen.findByText('Already confirmed')).toBeInTheDocument();
    const call = api.calls.find((c: ApiCall) => c.path === '/opportunities/opp-1/find-posting');
    expect(call?.search).toContain('seen=searching');
  });

  // #835 (qa on #830): a board that could not be read says so and offers a retry; it is never
  // "no close match".
  it('a board that cannot be read says so, with Try again (#835)', async () => {
    const api = setup({ 'POST /opportunities/opp-1/find-posting': { outcome: 'unreachable' } });
    renderWithProviders(<DetailsPanel opp={BARE} />);

    await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));

    expect(await screen.findByText(/couldn't read the company's board/i)).toBeInTheDocument();
    expect(screen.queryByText(/no close match/i)).not.toBeInTheDocument();
    const finds = () =>
      api.calls.filter((c: ApiCall) => c.path === '/opportunities/opp-1/find-posting').length;
    expect(finds()).toBe(1);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(finds()).toBe(2));
  });

  // #866 (qa on #860): the banner and the notice each said it, each with a Try again.
  it.each([
    ['failed', true],
    ['none_found', true],
    ['ambiguous', true],
    ['no_board', true],
    ['edited', false],
  ] as const)(
    'a board that cannot be read, at %s: one notice, one Try again (#866)',
    async (postingStateDetail, confirmable) => {
      const opp = { ...BARE, postingState: 'needs_review', postingStateDetail } as OpportunityView;
      const api = setup({ 'POST /opportunities/opp-1/find-posting': { outcome: 'unreachable' } });
      renderWithProviders(<DetailsPanel opp={opp} />);
      await userEvent.click(await screen.findByRole('button', { name: 'Find posting' }));

      expect(await screen.findByText(/couldn't read the company's board/i)).toBeInTheDocument();
      const notices = screen.getAllByRole('status');
      expect(notices).toHaveLength(1);
      expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(1);
      // The state's own way to settle it stays.
      expect(screen.queryAllByRole('button', { name: 'Confirm' })).toHaveLength(
        confirmable ? 1 : 0,
      );
      await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() =>
        expect(
          api.calls.filter((c: ApiCall) => c.path === '/opportunities/opp-1/find-posting'),
        ).toHaveLength(2),
      );
    },
  );

  // A failed detection used to open the dialog, so the way to add the posting by hand stays.
  it('a board that cannot be read keeps the way to add the posting by hand (#866)', async () => {
    const api = setup({
      'POST /opportunities/opp-1/find-posting': { outcome: 'unreachable' },
      'POST /opportunities/opp-1/posting': { ...BARE, descriptionMd: 'Pasted.' },
    });
    renderWithProviders(<DetailsPanel opp={BARE} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Find posting' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Add by hand' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add the posting' });
    expect(dialog).toHaveTextContent(
      "The company's board couldn't be read just now. Add the posting by hand.",
    );
    expect(dialog).not.toHaveTextContent(/no job board found|no close match/i);
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Pasted text' }));
    await userEvent.type(within(dialog).getByLabelText('Posting description'), 'Pasted.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Attach posting' }));
    await waitFor(() =>
      expect(
        api.calls.find((c: ApiCall) => c.path === '/opportunities/opp-1/posting')?.body,
      ).toEqual({ text: 'Pasted.' }),
    );
  });

  it('a Refetch that cannot read the board says so once, and offers no pasting over it (#866)', async () => {
    setup({ 'POST /opportunities/opp-1/find-posting': { outcome: 'unreachable' } });
    renderWithProviders(
      <DetailsPanel opp={{ ...BARE, descriptionMd: 'Text.', postingState: 'confirmed' }} />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Refetch' }));
    const ask = await screen.findByRole('dialog', { name: 'Refetch this posting?' });
    await userEvent.click(within(ask).getByRole('button', { name: 'Refetch' }));
    expect(await screen.findByText(/couldn't read the company's board/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Add by hand' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  });

  it('the notice goes when a check settles the posting meanwhile (#866)', async () => {
    let now = { ...BARE } as OpportunityView;
    setup({
      'GET /opportunities/opp-1': () => now,
      'POST /opportunities/opp-1/find-posting': { outcome: 'unreachable' },
    });
    const { queryClient } = renderWithProviders(<Live />);
    await userEvent.click(await screen.findByRole('button', { name: 'Find posting' }));
    expect(await screen.findByText(/couldn't read the company's board/i)).toBeInTheDocument();

    // While a check runs it says only that, then what it found.
    now = { ...BARE, postingState: 'searching' } as OpportunityView;
    await act(() => queryClient.invalidateQueries({ queryKey: qk.opportunity('opp-1') }));
    expect(await screen.findByText(/checking the company's job board/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn't read the company's board/i)).toBeNull();

    now = {
      ...BARE,
      postingState: 'needs_review',
      postingStateDetail: 'none_found',
    } as OpportunityView;
    await act(() => queryClient.invalidateQueries({ queryKey: qk.opportunity('opp-1') }));
    expect(
      await screen.findByText("This posting is not on the company's board right now."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/couldn't read the company's board/i)).toBeNull();
  });

  it.each([
    [['description'], 'Updated from the board: description.'],
    [['link', 'job'], 'Updated from the board: posting link, job on the board.'],
    [
      ['location', 'remote', 'compensation'],
      'Updated from the board: location, remote, compensation.',
    ],
  ])(
    'a Refetch that changed %j says what changed, not "Posting attached" (#866)',
    async (changed, said) => {
      setup({
        'POST /opportunities/opp-1/find-posting': {
          outcome: 'attached',
          changed,
          opportunity: BARE,
          candidate: CANDIDATE('A title never in a toast here', 'United States', '7663059003'),
        },
      });
      renderWithProviders(<DetailsPanel opp={BARE} />);
      await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));
      expect(await toastRegion().findByText('Posting updated')).toBeInTheDocument();
      expect(toastRegion().getByText(said)).toBeInTheDocument();
      expect(toastRegion().queryByText(/A title never in a toast here/)).toBeNull();
    },
  );

  it('a Refetch from a board read in part says that too (#866)', async () => {
    setup({
      'POST /opportunities/opp-1/find-posting': {
        outcome: 'attached',
        changed: ['description'],
        opportunity: BARE,
        candidate: CANDIDATE('Staff Product Manager, SIEM', 'United States', '7663059003'),
        note: 'Large Workday board: part read.',
      },
    });
    renderWithProviders(<DetailsPanel opp={BARE} />);
    await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));
    expect(
      await toastRegion().findByText(
        'Updated from the board: description. Large Workday board: part read.',
      ),
    ).toBeInTheDocument();
  });

  it('a Refetch that changes nothing says so, not "Posting attached" (#835)', async () => {
    setup({
      'POST /opportunities/opp-1/find-posting': {
        outcome: 'attached',
        unchanged: true,
        opportunity: BARE,
        candidate: CANDIDATE('Staff Product Manager, SIEM', 'United States', '7663059003'),
      },
    });
    renderWithProviders(<DetailsPanel opp={BARE} />);
    await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));
    expect(await toastRegion().findByText('Nothing changed')).toBeInTheDocument();
    expect(toastRegion().getByText("The posting matches the company's board.")).toBeInTheDocument();
    expect(screen.queryByText('Posting attached')).not.toBeInTheDocument();
  });

  // tl on #930: a description kept is not compared, so the toast must not say it matches.
  it('a Refetch that changes nothing and kept your description says it was kept (#866)', async () => {
    setup({
      'POST /opportunities/opp-1/find-posting': {
        outcome: 'attached',
        unchanged: true,
        keptDescription: true,
        opportunity: { ...BARE, postingState: 'confirmed' },
        candidate: CANDIDATE('Staff Product Manager, SIEM', 'United States', '7663059003'),
      },
    });
    renderWithProviders(<DetailsPanel opp={BARE} />);
    await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));
    expect(await toastRegion().findByText('Nothing changed')).toBeInTheDocument();
    expect(toastRegion().getByText('Your own description was kept.')).toBeInTheDocument();
    expect(screen.queryByText(/matches the company's board/)).toBeNull();
  });

  // The user's confirmation does not say whose text it is.
  it('a Refetch that changes nothing on a posting you confirmed matches when the text is the board’s (#866)', async () => {
    setup({
      'POST /opportunities/opp-1/find-posting': {
        outcome: 'attached',
        unchanged: true,
        opportunity: { ...BARE, postingState: 'confirmed', postingStateDetail: 'user_confirmed' },
        candidate: CANDIDATE('Staff Product Manager, SIEM', 'United States', '7663059003'),
      },
    });
    renderWithProviders(<DetailsPanel opp={BARE} />);
    await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));
    expect(
      await toastRegion().findByText("The posting matches the company's board."),
    ).toBeInTheDocument();
  });

  it('a Refetch that changed the link and kept your description says both, and offers no Undo (#866)', async () => {
    const matched = { ...BARE, postingState: 'confirmed', postingStateDetail: null };
    setup({
      'GET /opportunities/opp-1': matched,
      'POST /opportunities/opp-1/find-posting': {
        outcome: 'attached',
        changed: ['link'],
        keptDescription: true,
        opportunity: matched,
        candidate: CANDIDATE('Staff Product Manager, SIEM', 'United States', '7663059003'),
      },
    });
    renderWithProviders(<Live />);
    await userEvent.click(await screen.findByRole('button', { name: 'Refetch' }));
    const ask = await screen.findByRole('dialog', { name: 'Refetch this posting?' });
    await userEvent.click(within(ask).getByRole('button', { name: 'Refetch' }));
    expect(
      await toastRegion().findByText(
        'Updated from the board: posting link. Your own description was kept.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Matched on the company's board.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('a Refetch that changes nothing says what the board read left out (#866)', async () => {
    setup({
      'POST /opportunities/opp-1/find-posting': {
        outcome: 'attached',
        unchanged: true,
        opportunity: BARE,
        candidate: CANDIDATE('Staff Product Manager, SIEM', 'United States', '7663059003'),
        note: 'Large Workday board: part read.',
      },
    });
    renderWithProviders(<DetailsPanel opp={BARE} />);
    await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));
    expect(
      await toastRegion().findByText(
        "The posting matches the company's board. Large Workday board: part read.",
      ),
    ).toBeInTheDocument();
  });

  it('attaches a single match without opening the picker', async () => {
    const api = setup({
      'POST /opportunities/opp-1/find-posting': {
        outcome: 'attached',
        opportunity: { ...BARE, descriptionMd: 'What We Do: cybercrime is growing.' },
        candidate: CANDIDATE('Staff Product Manager, SIEM', 'United States', '7663059003'),
      },
    });
    renderWithProviders(<DetailsPanel opp={BARE} />);

    await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));

    expect(await screen.findByText('Posting attached')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.calls.some((c: ApiCall) => c.path === '/opportunities/opp-1/find-posting')).toBe(
      true,
    );
  });

  it('carries the large-board note into the attached toast (#114: no dialog opens on this path)', async () => {
    setup({
      'POST /opportunities/opp-1/find-posting': {
        outcome: 'attached',
        opportunity: { ...BARE, descriptionMd: 'What We Do: cybercrime is growing.' },
        candidate: CANDIDATE('Staff Product Manager, SIEM', 'United States', '7663059003'),
        note: 'Large Workday board: showing the first 200 of 500 postings. Paste the posting link or text if yours is not among them.',
      },
    });
    renderWithProviders(<DetailsPanel opp={BARE} />);

    await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));

    // Asserted on the note text specifically, not the "Posting attached" title: that title is
    // not unique to this test's toast when run alongside the others in this file (the toast
    // store is shared across tests), so it is the wrong thing to key the assertion on here.
    expect(
      await screen.findByText(
        /Staff Product Manager, SIEM\. Large Workday board: showing the first 200 of 500/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  // #1016: both sentences end in one full stop, whichever of them are there.
  it.each([
    [{}, 'Staff Product Manager, SIEM'],
    [{ note: PARTLY }, `Staff Product Manager, SIEM. ${PARTLY}`],
    [{ keptDescription: true }, 'Staff Product Manager, SIEM. Your own description was kept.'],
    [
      { keptDescription: true, note: PARTLY },
      `Staff Product Manager, SIEM. Your own description was kept. ${PARTLY}`,
    ],
  ])('the attached toast has one full stop between its sentences: %o', async (said, text) => {
    setup({
      'POST /opportunities/opp-1/find-posting': {
        outcome: 'attached',
        opportunity: { ...BARE, descriptionMd: 'What We Do: cybercrime is growing.' },
        candidate: CANDIDATE('Staff Product Manager, SIEM', 'United States', '7663059003'),
        ...said,
      },
    });
    renderWithProviders(<DetailsPanel opp={BARE} />);
    await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));
    expect(await toastRegion().findByText(text)).toBeInTheDocument();
  });

  it('lists candidates with their locations and attaches the chosen one', async () => {
    const api = setup({
      'POST /opportunities/opp-1/find-posting': {
        outcome: 'candidates',
        candidates: [
          CANDIDATE('Staff Product Manager, SIEM', 'United States', '7663059003'),
          CANDIDATE('Staff Product Manager, Core Platform', 'Remote', '8014352003'),
        ],
        board: [
          CANDIDATE('Staff Product Manager, SIEM', 'United States', '7663059003'),
          CANDIDATE('Staff Product Manager, Core Platform', 'Remote', '8014352003'),
          CANDIDATE('Senior Product Manager, SOC Experience', 'Remote', '7995748003'),
        ],
      },
      'POST /opportunities/opp-1/posting': (c: ApiCall) => ({
        ...BARE,
        descriptionMd: (c.body as { posting: { descriptionMd: string } }).posting.descriptionMd,
      }),
    });
    renderWithProviders(<DetailsPanel opp={BARE} />);

    await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Staff Product Manager, SIEM')).toBeInTheDocument();
    expect(within(dialog).getByText('United States')).toBeInTheDocument();

    await userEvent.click(
      within(dialog).getAllByRole('button', { name: /^attach$/i })[0] as HTMLElement,
    );

    await waitFor(() =>
      expect(api.calls.some((c: ApiCall) => c.path === '/opportunities/opp-1/posting')).toBe(true),
    );
    const call = api.calls.find((c: ApiCall) => c.path === '/opportunities/opp-1/posting');
    expect((call!.body as { posting: { externalId: string } }).posting.externalId).toBe(
      '7663059003',
    );
  });

  it('searches the whole board from the picker', async () => {
    setup({
      'POST /opportunities/opp-1/find-posting': {
        outcome: 'candidates',
        candidates: [CANDIDATE('Staff Product Manager, SIEM', 'United States', '7663059003')],
        board: [
          CANDIDATE('Staff Product Manager, SIEM', 'United States', '7663059003'),
          CANDIDATE('Senior Product Manager, SOC Experience', 'Remote', '7995748003'),
        ],
      },
    });
    renderWithProviders(<DetailsPanel opp={BARE} />);

    await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).queryByText('Senior Product Manager, SOC Experience'),
    ).not.toBeInTheDocument();

    await userEvent.type(within(dialog).getByLabelText('Search the board'), 'SOC');

    expect(within(dialog).getByText('Senior Product Manager, SOC Experience')).toBeInTheDocument();
    expect(within(dialog).queryByText('Staff Product Manager, SIEM')).not.toBeInTheDocument();
  });

  // #812 (qa on #804): one candidate is not "more than one"; the server's note says why it is
  // offered rather than attached.
  it('one candidate is offered as one, with the reason the server gives', async () => {
    setup({
      'POST /opportunities/opp-1/find-posting': {
        outcome: 'candidates',
        candidates: [CANDIDATE('Staff Product Manager, SIEM', 'United States', '7663059003')],
        board: [CANDIDATE('Staff Product Manager, SIEM', 'United States', '7663059003')],
        note: "The job this opportunity names isn't on the company's board now.",
      },
    });
    renderWithProviders(<DetailsPanel opp={BARE} />);

    await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText(/more than one posting/i)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/one posting on the .* board may match/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/isn't on the company's board now/i)).toBeInTheDocument();
  });

  it('a company name ending in s takes an apostrophe alone (#866)', async () => {
    setup({
      'POST /opportunities/opp-1/find-posting': {
        outcome: 'candidates',
        candidates: [CANDIDATE('Staff Product Manager, SIEM', 'United States', '1')],
        board: [],
        needsConfirmation: true,
      },
    });
    renderWithProviders(
      <DetailsPanel opp={{ ...BARE, companyName: 'Vandelay Industries' } as OpportunityView} />,
    );
    await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));
    expect(
      await screen.findByText(/on a board that is not Vandelay Industries' own board\./),
    ).toBeInTheDocument();
  });

  it('says a referenced posting needs checking when it is not the company board', async () => {
    setup({
      'POST /opportunities/opp-1/find-posting': {
        outcome: 'candidates',
        needsConfirmation: true,
        candidates: [CANDIDATE('Director of Product, Acme', 'Remote', '999')],
        board: [CANDIDATE('Director of Product, Acme', 'Remote', '999')],
      },
    });
    renderWithProviders(<DetailsPanel opp={BARE} />);

    await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/came from a link in a message/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/not Sentinel Edge's own board/i)).toBeInTheDocument();
  });

  it('says how many postings the search box filters', async () => {
    setup({
      'POST /opportunities/opp-1/find-posting': {
        outcome: 'none',
        candidates: [
          CANDIDATE('Staff Product Manager - Data Products', 'Remote - US', '1'),
          CANDIDATE('Staff Engineer, Experimentation', 'Remote - US', '2'),
        ],
      },
    });
    renderWithProviders(<DetailsPanel opp={BARE} />);

    await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('Filters the 2 postings found on the board.'),
    ).toBeInTheDocument();
  });

  it('falls back to pasting when the company has no board', async () => {
    const api = setup({
      'POST /opportunities/opp-1/find-posting': {
        outcome: 'no_board',
        needsCareersUrl: true,
        hint: 'This site cannot be fetched. Open the posting in your browser and paste the description text instead.',
      },
      'POST /opportunities/opp-1/posting': (c: ApiCall) => ({
        ...BARE,
        descriptionMd: (c.body as { text: string }).text,
      }),
    });
    renderWithProviders(<DetailsPanel opp={BARE} />);

    await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/paste the description text/i)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByLabelText('Pasted text'));
    await userEvent.type(
      within(dialog).getByLabelText('Posting description'),
      'Own the SIEM roadmap.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Attach posting' }));

    await waitFor(() => {
      const call = api.calls.find((c: ApiCall) => c.path === '/opportunities/opp-1/posting');
      expect((call?.body as { text?: string } | undefined)?.text).toBe('Own the SIEM roadmap.');
    });
  });

  it('shows the large-board truncation note from the server', async () => {
    setup({
      'POST /opportunities/opp-1/find-posting': {
        outcome: 'candidates',
        note: 'Large Workday board: showing the first 200 of 643 postings. Paste the posting link or text if yours is not among them.',
        candidates: [CANDIDATE('Staff Product Manager, SIEM', 'United States', '7663059003')],
        board: [CANDIDATE('Staff Product Manager, SIEM', 'United States', '7663059003')],
      },
    });
    renderWithProviders(<DetailsPanel opp={BARE} />);

    await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/showing the first 200 of 643 postings/i)).toBeInTheDocument();
  });

  it('shows the board listing when nothing is confident', async () => {
    setup({
      'POST /opportunities/opp-1/find-posting': {
        outcome: 'none',
        candidates: [
          CANDIDATE('Staff Product Manager - Data Products', 'Remote - US', '5550001001'),
        ],
      },
    });
    renderWithProviders(<DetailsPanel opp={BARE} />);

    await userEvent.click(await screen.findByRole('button', { name: /find posting/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/no close match/i)).toBeInTheDocument();
    expect(within(dialog).getByText('Staff Product Manager - Data Products')).toBeInTheDocument();
  });

  // #858: at `edited` the board's copy can replace what the user wrote, so they are asked first, and
  // the request names the text they agreed to lose.
  describe('from edited, replacing the description asks first (#858)', () => {
    const MINE = 'my own notes: café, 東京 🚀';
    const EDITED = {
      ...BARE,
      descriptionMd: MINE,
      descriptionIsUserWritten: true,
      postingState: 'needs_review',
      postingStateDetail: 'edited',
    } as OpportunityView;
    const ASK = 'Replace your description?';
    const ROW = CANDIDATE('Staff Product Manager, SIEM', 'United States', '7663059003');
    const REPLACED = {
      ...EDITED,
      descriptionMd: 'What We Do: cybercrime is growing.',
      descriptionIsUserWritten: false,
      postingState: 'confirmed',
      postingStateDetail: null,
    } as OpportunityView;
    const CANDIDATES = { outcome: 'candidates', candidates: [ROW], board: [ROW] };

    const searches = (calls: ApiCall[]) =>
      calls.filter((c) => c.path === '/opportunities/opp-1/find-posting');
    const attaches = (calls: ApiCall[]) =>
      calls.filter((c) => c.path === '/opportunities/opp-1/posting');
    const agreed = (c: ApiCall | undefined) =>
      new URLSearchParams(c?.search).get('replaceDescription');
    const click = async (name: string) =>
      await userEvent.click(await screen.findByRole('button', { name }));
    const answer = async (name: string) =>
      await userEvent.click(
        within(await screen.findByRole('dialog', { name: ASK })).getByRole('button', { name }),
      );

    describe.each(['Review board copy', 'Find posting'])('%s', (action) => {
      it('asks, naming that the edit will be lost; Cancel sends nothing', async () => {
        const { calls } = setup({});
        renderWithProviders(<DetailsPanel opp={EDITED} />);
        await click(action);
        const ask = await screen.findByRole('dialog', { name: ASK });
        expect(ask).toHaveTextContent(/edited this description by hand/i);
        expect(ask).toHaveTextContent(/your edit can't be recovered afterward/i);
        expect(searches(calls)).toEqual([]);
        await answer('Cancel');
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(searches(calls)).toEqual([]);
      });

      it('agreed, it searches, naming the text to be lost', async () => {
        const { calls } = setup({
          'POST /opportunities/opp-1/find-posting': {
            outcome: 'attached',
            opportunity: REPLACED,
            candidate: ROW,
          },
        });
        renderWithProviders(<DetailsPanel opp={EDITED} />);
        await click(action);
        await answer('Find and replace');
        expect(await screen.findByText(ROW.posting.title)).toBeInTheDocument();
        expect(searches(calls)).toHaveLength(1);
        expect(agreed(searches(calls)[0])).toBe(sha256Hex(MINE));
        expect(new URLSearchParams(searches(calls)[0]?.search).get('seen')).toBe('needs_review');
        expect(screen.queryByRole('dialog')).toBeNull();
      });
    });

    // The answer is about the text that was there when it was asked, not about what came since.
    it('text saved elsewhere while it asks is not what was agreed to', async () => {
      let now = EDITED;
      const { calls } = setup({
        'GET /opportunities/opp-1': () => now,
        'POST /opportunities/opp-1/find-posting': {
          outcome: 'attached',
          candidate: ROW,
          keptDescription: true,
        },
      });
      const { queryClient } = renderWithProviders(<Live />);
      await click('Review board copy');
      await screen.findByRole('dialog', { name: ASK });
      now = { ...EDITED, descriptionMd: 'saved in another tab' };
      await act(() => queryClient.invalidateQueries({ queryKey: qk.opportunity('opp-1') }));
      expect(await screen.findByText('saved in another tab')).toBeInTheDocument();
      await answer('Find and replace');
      await waitFor(() => expect(searches(calls)).toHaveLength(1));
      expect(agreed(searches(calls)[0])).toBe(sha256Hex(MINE));
      // The server kept it, and it is said: they had agreed to have it replaced.
      expect(
        await screen.findByText('Staff Product Manager, SIEM. Your own description was kept.'),
      ).toBeInTheDocument();
    });

    it('a job recognised with the description kept says both', async () => {
      setup({
        'POST /opportunities/opp-1/find-posting': { outcome: 'identified', keptDescription: true },
      });
      renderWithProviders(<DetailsPanel opp={{ ...EDITED, postingStateDetail: 'none_found' }} />);
      await click('Find posting');
      const said = await screen.findByText('Recognised on Greenhouse');
      expect(said.closest('li')).toHaveTextContent('Your own description was kept.');
    });

    it('asked once each: the next search asks again', async () => {
      const { calls } = setup({
        'POST /opportunities/opp-1/find-posting': { outcome: 'unreachable' },
      });
      renderWithProviders(<DetailsPanel opp={EDITED} />);
      await click('Find posting');
      await answer('Find and replace');
      await click('Try again');
      expect(await screen.findByRole('dialog', { name: ASK })).toBeInTheDocument();
      expect(searches(calls)).toHaveLength(1);
    });

    it.each([
      ['a description of the system’s', { descriptionIsUserWritten: false }],
      ['no description', { descriptionMd: null, descriptionIsUserWritten: false }],
      ['another detail, where the description is kept', { postingStateDetail: 'none_found' }],
    ] as const)('%s: nothing to ask, and nothing agreed', async (_what, over) => {
      const { calls } = setup({
        'POST /opportunities/opp-1/find-posting': { outcome: 'unreachable' },
      });
      renderWithProviders(<DetailsPanel opp={{ ...EDITED, ...over } as OpportunityView} />);
      await click('Find posting');
      await waitFor(() => expect(searches(calls)).toHaveLength(1));
      expect(agreed(searches(calls)[0])).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('a row picked after an agreed search is not asked about again, and carries the agreement', async () => {
      const { calls } = setup({
        'POST /opportunities/opp-1/find-posting': CANDIDATES,
        'POST /opportunities/opp-1/posting': REPLACED,
      });
      renderWithProviders(<DetailsPanel opp={EDITED} />);
      await click('Review board copy');
      await answer('Find and replace');
      await click('Attach');
      await waitFor(() => expect(attaches(calls)).toHaveLength(1));
      expect(attaches(calls)[0]?.body).toEqual({
        posting: ROW.posting,
        replaceDescription: sha256Hex(MINE),
      });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('a row picked where nothing was agreed carries nothing, and says the description was kept', async () => {
      const KEPT = {
        ...EDITED,
        postingStateDetail: 'none_found',
        descriptionMd: MINE,
      } as OpportunityView;
      const { calls } = setup({
        'POST /opportunities/opp-1/find-posting': CANDIDATES,
        'POST /opportunities/opp-1/posting': { ...KEPT, postingState: 'confirmed' },
      });
      renderWithProviders(<DetailsPanel opp={KEPT} />);
      await click('Find posting');
      await click('Attach');
      await waitFor(() => expect(attaches(calls)).toHaveLength(1));
      expect(attaches(calls)[0]?.body).toEqual({ posting: ROW.posting });
      expect(
        await screen.findByText('Staff Product Manager, SIEM. Your own description was kept.'),
      ).toBeInTheDocument();
    });

    describe.each([
      ['pasted text', 'Pasted text', 'Posting description', 'Own the SIEM roadmap.', 'text'],
      ['a pasted link', 'Link', 'Posting link', 'https://careers.example/jobs/1', 'url'],
    ] as const)('%s', (_what, mode, field, value, key) => {
      async function paste(opp: OpportunityView, then: unknown) {
        const { calls } = setup({
          'POST /opportunities/opp-1/find-posting': CANDIDATES,
          'POST /opportunities/opp-1/posting': then,
        });
        renderWithProviders(<DetailsPanel opp={opp} />);
        await click('Find posting');
        if (opp === EDITED) await answer('Find and replace');
        await userEvent.click(await screen.findByLabelText(mode));
        await userEvent.type(screen.getByLabelText(field), value);
        await click('Attach posting');
        return calls;
      }

      it('asks, and Cancel sends nothing and keeps what was pasted', async () => {
        const calls = await paste(EDITED, REPLACED);
        const ask = await screen.findByRole('dialog', { name: ASK });
        expect(ask).toHaveTextContent(/your edit can't be recovered afterward/i);
        await answer('Cancel');
        await waitFor(() => expect(screen.queryByRole('dialog', { name: ASK })).toBeNull());
        expect(attaches(calls)).toEqual([]);
        expect(screen.getByLabelText(field)).toHaveValue(value);
      });

      // Only the question closes, not the dialog under it with what was pasted into it.
      it.each(['Escape', 'Cancel', 'Close'])('%s leaves the dialog under it open', async (how) => {
        await paste(EDITED, REPLACED);
        const ask = await screen.findByRole('dialog', { name: ASK });
        if (how === 'Escape') pressEscapeOn(ask);
        else await answer(how);
        // What a browser sends once it has closed, and jsdom does not.
        browserCloses(ask);
        await waitFor(() => expect(screen.queryByRole('dialog', { name: ASK })).toBeNull());
        expect(screen.getByRole('dialog', { name: 'Add the posting' })).toBeInTheDocument();
        expect(screen.getByLabelText(field)).toHaveValue(value);
      });

      it('agreed, it is attached, naming the text to be lost', async () => {
        const calls = await paste(EDITED, REPLACED);
        await answer('Replace');
        await waitFor(() => expect(attaches(calls)).toHaveLength(1));
        expect(attaches(calls)[0]?.body).toEqual({
          [key]: value,
          replaceDescription: sha256Hex(MINE),
        });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      });

      it('refused, the refusal is shown where it was pasted', async () => {
        await paste(EDITED, {
          status: 409,
          body: { error: { code: 'description_changed', message: 'It changed meanwhile.' } },
        });
        await answer('Replace');
        const dialog = await screen.findByRole('dialog', { name: 'Add the posting' });
        expect(await within(dialog).findByRole('alert')).toHaveTextContent('It changed meanwhile.');
        expect(screen.queryByRole('dialog', { name: ASK })).toBeNull();
      });

      it('does not ask over a description that is not the user’s', async () => {
        const calls = await paste(
          { ...EDITED, descriptionIsUserWritten: false } as OpportunityView,
          REPLACED,
        );
        await waitFor(() => expect(attaches(calls)).toHaveLength(1));
        expect(attaches(calls)[0]?.body).toEqual({ [key]: value });
      });
    });
  });
});
