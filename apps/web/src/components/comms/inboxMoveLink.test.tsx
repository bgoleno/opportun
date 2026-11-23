// What an Inbox row's actions say when the row leaves the list with them
// (https://github.com/bgoleno/opportun/issues/895). The list reloads before an action's outcome is
// reported, and a row that left with the reload took its callbacks with it: a refused Move said
// nothing, and "Message linked", "Message unlinked" and "Moved to Needs review" never showed.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders, toastRegion } from '@/test/render';
import type { CommunicationView } from './api';
import { Inbox } from './Inbox';

const BASE: CommunicationView = {
  id: 'c1',
  channel: 'gmail',
  threadKey: null,
  from: 'Riley <riley@acme.example>',
  to: ['me@example.com'],
  subject: 'Interview times',
  snippet: 'When are you free?',
  sentAt: Date.now() - 60_000,
  classification: 'scheduling',
  outreachKind: null,
  mismatchReason: null,
  confidence: 0.9,
  bodySource: 'stored',
  opportunityId: null,
  opportunityTitle: null,
  companyName: null,
  opportunityStage: null,
  needsReview: true,
  proposedTransition: null,
  createdAt: Date.now() - 60_000,
  externalId: 'gm-1',
  triageDecision: null,
  triageRule: null,
};
const LINKED: CommunicationView = {
  ...BASE,
  opportunityId: 'o1',
  opportunityTitle: 'Engineer',
  companyName: 'Acme',
  opportunityStage: 'applied',
  needsReview: false,
  proposedTransition: 'in_process',
};
const SPAM: CommunicationView = {
  ...BASE,
  classification: 'solicitation',
  outreachKind: 'broadcast_spam',
  needsReview: false,
};

type Answer = { status: number; body: unknown };
const refusal = (code: string, message?: string): Answer => ({
  status: 409,
  body: { error: { code, ...(message === undefined ? {} : { message }) } },
});
const REJECTED = refusal(
  'message_rejected',
  'This message has been rejected, so it was left as it is.',
);

/**
 * `row` in `view`'s list until the action answers, then `after` (null: it has left the list).
 * `routes` are the action's own.
 */
function serve(
  view: string,
  row: CommunicationView,
  after: CommunicationView | null,
  routes: Record<string, Answer>,
) {
  let acted = false;
  const table = Object.fromEntries(
    Object.entries(routes).map(([key, answer]) => [
      key,
      () => {
        acted = true;
        return answer;
      },
    ]),
  );
  return mockApi({
    'GET /communications': async (call: { search: string }) => {
      const here = new URLSearchParams(call.search).get('view') === view;
      // The lists do not all answer at once: this one's answer takes the row away while another's
      // is still on its way, and the action's outcome waits for them all.
      if (acted && !here) await new Promise((r) => setTimeout(r, 60));
      const now = acted ? after : row;
      const items = here && now !== null ? [now] : [];
      return { status: 200, body: { items, total: items.length } };
    },
    'GET /integrations/gmail': { connected: true, lastSyncAt: null, count: 0, status: null },
    'GET /opportunities': {
      items: [{ id: 'o1', title: 'Engineer', companyName: 'Acme', stage: 'applied' }],
      total: 1,
    },
    ...table,
  });
}

const gone = () => waitFor(() => expect(screen.queryByText('Interview times')).toBeNull());

async function openLink(user: ReturnType<typeof userEvent.setup>, button: string) {
  await user.click(await screen.findByRole('button', { name: button }));
  const dialog = await screen.findByRole('dialog', { name: 'Link to an opportunity' });
  return dialog;
}

async function pickAcme(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  await user.type(within(dialog).getByLabelText('Search'), 'Acme');
  await user.click(await within(dialog).findByRole('button', { name: /Engineer at Acme/ }));
}

describe('a refused Move (#895)', () => {
  const WHY = 'This message has been rejected, and its suggestion with it.';

  it('says why when the row leaves the list with it, as it does when rejected elsewhere', async () => {
    const user = userEvent.setup();
    serve('linked', LINKED, null, {
      'POST /communications/c1/accept-transition': refusal('no_proposal', WHY),
    });
    renderWithProviders(<Inbox initialTab="linked" />);
    await user.click(await screen.findByRole('button', { name: 'Move to In process' }));
    expect(await toastRegion().findByText('Stage not changed')).toBeInTheDocument();
    expect(toastRegion().getByText(WHY)).toBeInTheDocument();
    await gone();
  });

  it('says why, and the row refreshes, when it stays in the list without its suggestion', async () => {
    const user = userEvent.setup();
    serve(
      'linked',
      LINKED,
      { ...LINKED, proposedTransition: null },
      {
        'POST /communications/c1/accept-transition': refusal(
          'no_proposal',
          'This suggestion is no longer there: it was used, ignored or changed since you saw it.',
        ),
      },
    );
    renderWithProviders(<Inbox initialTab="linked" />);
    await user.click(await screen.findByRole('button', { name: 'Move to In process' }));
    expect(
      await toastRegion().findByText(/This suggestion is no longer there/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Move to In process' })).toBeNull(),
    );
    expect(screen.getByText('Interview times')).toBeInTheDocument();
  });

  it('never shows the raw code, from a server that sends no sentence', async () => {
    const user = userEvent.setup();
    serve('linked', LINKED, null, {
      'POST /communications/c1/accept-transition': refusal('no_proposal'),
    });
    renderWithProviders(<Inbox initialTab="linked" />);
    await user.click(await screen.findByRole('button', { name: 'Move to In process' }));
    expect(
      await toastRegion().findByText(
        'This message no longer suggests a move. Nothing was changed.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/no_proposal/)).toBeNull();
  });

  it('an accepted Move says so when the row leaves with it', async () => {
    const user = userEvent.setup();
    serve('linked', LINKED, null, {
      'POST /communications/c1/accept-transition': {
        status: 200,
        body: { communication: LINKED, opportunityId: 'o1', stage: 'in_process' },
      },
    });
    renderWithProviders(<Inbox initialTab="linked" />);
    await user.click(await screen.findByRole('button', { name: 'Move to In process' }));
    expect(await toastRegion().findByText('Moved to In process')).toBeInTheDocument();
    await gone();
  });
});

describe('the toasts of an action that takes its row out of the list (#895)', () => {
  it('Message linked', async () => {
    const user = userEvent.setup();
    serve('needs_review', BASE, null, {
      'POST /communications/c1/classify': { status: 200, body: LINKED },
    });
    renderWithProviders(<Inbox />);
    await pickAcme(user, await openLink(user, 'Link to opportunity'));
    expect(await toastRegion().findByText('Message linked')).toBeInTheDocument();
    await gone();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Message unlinked', async () => {
    const user = userEvent.setup();
    serve('linked', LINKED, null, {
      'POST /communications/c1/classify': { status: 200, body: BASE },
    });
    renderWithProviders(<Inbox initialTab="linked" />);
    const dialog = await openLink(user, 'Change link');
    await user.click(within(dialog).getByRole('button', { name: 'Unlink' }));
    expect(await toastRegion().findByText('Message unlinked')).toBeInTheDocument();
    await gone();
  });

  it('Moved to Needs review', async () => {
    const user = userEvent.setup();
    serve('spam', SPAM, null, {
      'POST /communications/c1/classify': { status: 200, body: BASE },
    });
    renderWithProviders(<Inbox initialTab="spam" />);
    await user.click(await screen.findByRole('button', { name: 'Not spam' }));
    expect(await toastRegion().findByText('Moved to Needs review')).toBeInTheDocument();
    await gone();
  });

  it('Classification saved', async () => {
    const user = userEvent.setup();
    serve('needs_review', BASE, null, {
      'POST /communications/c1/classify': { status: 200, body: { ...BASE, needsReview: false } },
    });
    renderWithProviders(<Inbox />);
    await user.click(await screen.findByRole('button', { name: 'Reclassify' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reclassify message' });
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await toastRegion().findByText('Classification saved')).toBeInTheDocument();
    await gone();
  });

  it('a row that stays: the toast, once, and the dialog closes', async () => {
    const user = userEvent.setup();
    serve(
      'linked',
      LINKED,
      { ...LINKED, opportunityTitle: 'Analyst' },
      {
        'POST /communications/c1/classify': { status: 200, body: LINKED },
      },
    );
    renderWithProviders(<Inbox initialTab="linked" />);
    const dialog = await openLink(user, 'Change link');
    await user.click(await within(dialog).findByRole('button', { name: /Engineer at Acme/ }));
    expect(await toastRegion().findByText('Message linked')).toBeInTheDocument();
    expect(toastRegion().getAllByText('Message linked')).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('a refused link (#895)', () => {
  it.each([
    ['Link to opportunity', 'needs_review', BASE],
    ['Change link', 'linked', { ...LINKED, companyName: null }],
  ] as const)(
    '%s on a message rejected elsewhere says why when the row goes',
    async (button, view, row) => {
      const user = userEvent.setup();
      serve(view, row, null, { 'POST /communications/c1/classify': REJECTED });
      renderWithProviders(<Inbox initialTab={view} />);
      await pickAcme(user, await openLink(user, button));
      expect(await toastRegion().findByText('Message not linked')).toBeInTheDocument();
      expect(
        toastRegion().getByText('This message has been rejected, so it was left as it is.'),
      ).toBeInTheDocument();
      await gone();
      expect(screen.queryByRole('dialog')).toBeNull();
    },
  );

  it('a failed Unlink is said in a toast when the row has gone', async () => {
    const user = userEvent.setup();
    serve('linked', LINKED, null, {
      'POST /communications/c1/classify': {
        status: 500,
        body: { error: { code: 'server_error', message: 'The server could not do that.' } },
      },
    });
    renderWithProviders(<Inbox initialTab="linked" />);
    const dialog = await openLink(user, 'Change link');
    await user.click(within(dialog).getByRole('button', { name: 'Unlink' }));
    expect(await toastRegion().findByText('Message not unlinked')).toBeInTheDocument();
    expect(toastRegion().getByText('The server could not do that.')).toBeInTheDocument();
  });

  it('says why and closes when the list still holds the row, as when its reload fails', async () => {
    const user = userEvent.setup();
    serve('needs_review', BASE, BASE, { 'POST /communications/c1/classify': REJECTED });
    renderWithProviders(<Inbox />);
    await pickAcme(user, await openLink(user, 'Link to opportunity'));
    expect(await toastRegion().findByText('Message not linked')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Not spam on a message rejected elsewhere says why', async () => {
    const user = userEvent.setup();
    serve('spam', SPAM, null, { 'POST /communications/c1/classify': REJECTED });
    renderWithProviders(<Inbox initialTab="spam" />);
    await user.click(await screen.findByRole('button', { name: 'Not spam' }));
    expect(await toastRegion().findByText('Not changed')).toBeInTheDocument();
    expect(
      toastRegion().getByText('This message has been rejected, so it was left as it is.'),
    ).toBeInTheDocument();
    await gone();
  });

  it('Reclassify on a message rejected elsewhere says why', async () => {
    const user = userEvent.setup();
    serve('needs_review', BASE, null, { 'POST /communications/c1/classify': REJECTED });
    renderWithProviders(<Inbox />);
    await user.click(await screen.findByRole('button', { name: 'Reclassify' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reclassify message' });
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await toastRegion().findByText('Classification not saved')).toBeInTheDocument();
    expect(
      toastRegion().getByText('This message has been rejected, so it was left as it is.'),
    ).toBeInTheDocument();
    await gone();
  });

  it('a failure that is not about the message is said in a toast too when the row has gone', async () => {
    const user = userEvent.setup();
    serve('needs_review', BASE, null, {
      'POST /communications/c1/classify': {
        status: 500,
        body: { error: { code: 'server_error', message: 'The server could not do that.' } },
      },
    });
    renderWithProviders(<Inbox />);
    await pickAcme(user, await openLink(user, 'Link to opportunity'));
    expect(await toastRegion().findByText('Message not linked')).toBeInTheDocument();
    expect(toastRegion().getByText('The server could not do that.')).toBeInTheDocument();
  });

  it('any other failure keeps the dialog open with the reason in it, and no toast', async () => {
    const user = userEvent.setup();
    serve('needs_review', BASE, BASE, {
      'POST /communications/c1/classify': {
        status: 500,
        body: { error: { code: 'server_error', message: 'The server could not do that.' } },
      },
    });
    renderWithProviders(<Inbox />);
    const dialog = await openLink(user, 'Link to opportunity');
    await pickAcme(user, dialog);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The server could not do that.',
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getByRole('dialog', { name: 'Link to an opportunity' })).toBeInTheDocument();
    expect(screen.queryByText('Message not linked')).toBeNull();
  });
});
