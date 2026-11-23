// Editing the posting fields (Task 7, FR-O1): the description and the posting link are editable
// after creation, which is what closes the hole that left imported opportunities blank forever.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { OpportunityView } from '@/lib/opportunities';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { useOpportunity } from './api';
import { DetailsPanel } from './DetailsPanel';

const NOW = Date.now();

const OPP = {
  id: 'opp-1',
  userId: 'u1',
  companyId: 'c1',
  companyName: 'Sentinel Edge',
  title: 'Product Manager, SIEM',
  stage: 'in_process',
  sourceKind: 'import',
  priority: 2,
  descriptionMd: 'the description I already had',
  postingUrl: null,
  location: null,
  remote: null,
  compNote: null,
  createdAt: NOW,
  updatedAt: NOW,
} as unknown as OpportunityView;

function setup() {
  return mockApi({
    'GET /opportunities/opp-1/attachments': { items: [], total: 0 },
    'PATCH /opportunities/opp-1': (c: ApiCall) => ({ ...OPP, ...(c.body as object) }),
  });
}

const patches = (api: { calls: ApiCall[] }) => api.calls.filter((c) => c.method === 'PATCH');

describe('posting fields', () => {
  it('edits the description and saves it through PATCH', async () => {
    const api = setup();
    renderWithProviders(<DetailsPanel opp={OPP} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Edit description' }));
    const field = screen.getByLabelText('Description');
    await userEvent.clear(field);
    await userEvent.type(field, 'Own the SIEM roadmap.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patches(api)).toHaveLength(1));
    expect(patches(api)[0]!.body).toEqual({ descriptionMd: 'Own the SIEM roadmap.' });
  });

  it('edits the posting link and rejects a value that is not a link', async () => {
    const api = setup();
    renderWithProviders(<DetailsPanel opp={OPP} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Edit link' }));
    const field = screen.getByLabelText('Posting link');
    await userEvent.type(field, 'not a link');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Enter an http or https link')).toBeInTheDocument();
    expect(patches(api)).toHaveLength(0);

    await userEvent.clear(field);
    await userEvent.type(field, 'https://job-boards.greenhouse.io/sentineledge/jobs/7663059003');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patches(api)).toHaveLength(1));
    expect(patches(api)[0]!.body).toEqual({
      postingUrl: 'https://job-boards.greenhouse.io/sentineledge/jobs/7663059003',
    });
  });

  it('cancels an edit without sending anything', async () => {
    const api = setup();
    renderWithProviders(<DetailsPanel opp={OPP} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Edit description' }));
    await userEvent.type(screen.getByLabelText('Description'), ' and more');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(patches(api)).toHaveLength(0);
    expect(screen.getByText('the description I already had')).toBeInTheDocument();
  });

  it('clears the posting link when the field is emptied', async () => {
    const api = setup();
    renderWithProviders(
      <DetailsPanel
        opp={{ ...OPP, postingUrl: 'https://example.com/jobs/1' } as OpportunityView}
      />,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Edit link' }));
    await userEvent.clear(screen.getByLabelText('Posting link'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patches(api)).toHaveLength(1));
    expect(patches(api)[0]!.body).toEqual({ postingUrl: null });
  });
});

// https://github.com/bgoleno/opportun/issues/737 (qa's regression pass): Cancel during a slow link
// save closed the editor on the old link, and the card switched to the new one a few seconds later
// with nothing said. The server stores the link whatever the editor does, so a save that settles
// after Cancel says how it ended.
describe('posting link: Cancel while a save is in flight (#737)', () => {
  const NEW_LINK = 'https://job-boards.greenhouse.io/sentineledge/jobs/7663059003';

  /** The page as the app has it: the card reads the opportunity from its query. */
  function Page() {
    const { data } = useOpportunity('opp-1');
    return data === undefined ? null : <DetailsPanel opp={data} />;
  }

  function heldSave(outcome: 'ok' | 'fail') {
    let server = { ...OPP };
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const api = mockApi({
      'GET /opportunities/opp-1': () => server,
      'GET /opportunities/opp-1/attachments': { items: [], total: 0 },
      'GET /opportunities/opp-1/timeline': { items: [], total: 0 },
      'PATCH /opportunities/opp-1': async (c: ApiCall) => {
        await held;
        if (outcome === 'fail') {
          return {
            status: 500,
            body: { error: { code: 'internal', message: 'Internal server error' } },
          };
        }
        server = { ...server, ...(c.body as object) };
        return server;
      },
    });
    return { api, release };
  }

  async function startSave(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'Edit link' }));
    await user.type(screen.getByLabelText('Posting link'), NEW_LINK);
    await user.click(screen.getByRole('button', { name: 'Save' }));
  }

  it('Cancel, then the save lands: the card shows the new link and says it was saved', async () => {
    const user = userEvent.setup();
    const { api, release } = heldSave('ok');
    renderWithProviders(<Page />);
    await startSave(user);
    await waitFor(() => expect(patches(api)).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('No posting link.')).toBeInTheDocument();
    release();
    expect(await screen.findByText('Posting link saved')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: NEW_LINK })).toBeInTheDocument();
  });

  it('Cancel, then the save fails: the old link stays and the failure is said', async () => {
    const user = userEvent.setup();
    const { api, release } = heldSave('fail');
    renderWithProviders(<Page />);
    await startSave(user);
    await waitFor(() => expect(patches(api)).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    release();
    expect(await screen.findByText('Posting link not saved')).toBeInTheDocument();
    expect(screen.getByText('No posting link.')).toBeInTheDocument();
  });

  it('the save lands before any Cancel: the editor closes on the new link, with no toast', async () => {
    const user = userEvent.setup();
    const { release } = heldSave('ok');
    renderWithProviders(<Page />);
    await startSave(user);
    release();
    expect(await screen.findByRole('link', { name: NEW_LINK })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.queryByText('Posting link saved')).toBeNull();
  });

  it('the save fails before any Cancel: the editor says so, and Cancel leaves the old link', async () => {
    const user = userEvent.setup();
    const { release } = heldSave('fail');
    renderWithProviders(<Page />);
    await startSave(user);
    release();
    expect(await screen.findByText('Internal server error')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('No posting link.')).toBeInTheDocument();
    expect(screen.queryByText('Posting link not saved')).toBeNull();
  });
});

// https://github.com/bgoleno/opportun/issues/785 (qa on #787): a late "Posting link saved" from a
// cancelled save named no link, so after a later save of another link it read as that one's. It
// names the link it sent, and says when a later save has replaced it: a save answers with the row
// as it now is (#714), the last link sent.
describe('posting link: the late toast of a cancelled save names its link (#785)', () => {
  const FIRST = 'https://job-boards.greenhouse.io/sentineledge/jobs/7663059003';
  const SECOND = 'https://job-boards.greenhouse.io/sentineledge/jobs/7663059004';

  function Page() {
    const { data } = useOpportunity('opp-1');
    return data === undefined ? null : <DetailsPanel opp={data} />;
  }

  /** The server writes each save as it arrives (#714) and holds only the first one's answer. */
  function firstHeld() {
    let server = { ...OPP };
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let saves = 0;
    mockApi({
      'GET /opportunities/opp-1': () => server,
      'GET /opportunities/opp-1/attachments': { items: [], total: 0 },
      'GET /opportunities/opp-1/timeline': { items: [], total: 0 },
      'PATCH /opportunities/opp-1': async (c: ApiCall) => {
        saves += 1;
        server = { ...server, ...(c.body as object) };
        if (saves === 1) await held;
        return server;
      },
    });
    return { release };
  }

  async function saveLink(user: ReturnType<typeof userEvent.setup>, value: string) {
    await user.click(await screen.findByRole('button', { name: 'Edit link' }));
    const field = screen.getByLabelText('Posting link');
    await user.clear(field);
    await user.type(field, value);
    await user.click(screen.getByRole('button', { name: 'Save' }));
  }

  it('Cancel, then the save lands: the toast names the link saved', async () => {
    const user = userEvent.setup();
    const { release } = firstHeld();
    renderWithProviders(<Page />);
    await saveLink(user, FIRST);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    release();
    expect(await screen.findByText('Posting link saved')).toBeInTheDocument();
    expect(screen.getByText(FIRST, { selector: ':not(a)' })).toBeInTheDocument();
  });

  it('Cancel, reopen and save another link first: the late toast says the first was replaced', async () => {
    const user = userEvent.setup();
    const { release } = firstHeld();
    renderWithProviders(<Page />);
    await saveLink(user, FIRST);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await saveLink(user, SECOND);
    expect(await screen.findByRole('link', { name: SECOND })).toBeInTheDocument();
    release();
    expect(await screen.findByText('Posting link saved, then replaced')).toBeInTheDocument();
    expect(screen.getByText(FIRST, { selector: ':not(a)' })).toBeInTheDocument();
    expect(screen.queryByText('Posting link saved')).toBeNull();
    // The card keeps the later link.
    expect(screen.getByRole('link', { name: SECOND })).toBeInTheDocument();
  });
});
