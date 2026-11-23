// Find posting (Task 6, FR-O1): the Description card offers to look the posting up, one
// confident match lands without a dialog, several open the picker, and a company with no board
// falls back to pasting. Candidate text from a board is rendered as text, never as markup.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { OpportunityView } from '@/lib/opportunities';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
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
    expect(await screen.findByText('Nothing changed')).toBeInTheDocument();
    expect(screen.queryByText('Posting attached')).not.toBeInTheDocument();
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
});
