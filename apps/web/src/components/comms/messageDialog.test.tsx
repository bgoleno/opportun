// What the dialog can show once bodies are not stored (spec D2, Plan 3 Tasks 1 and 3): the
// headers, the snippet, and a link to the message where it actually lives. The link is the
// reason the rest of this feature is allowed to keep so little.
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import type { CommunicationView } from './api';
import { MessageDialog } from './MessageDialog';

const CONNECTED = {
  connected: true,
  lastSyncAt: null,
  count: 0,
  status: null,
  lookbackDays: 180,
  accountEmail: 'mailbox@gmail.test',
};

const comm = (over: Partial<CommunicationView> = {}): CommunicationView =>
  ({
    id: 'c1',
    channel: 'gmail',
    externalId: '1a14802e3951170a',
    triageDecision: 'passed',
    triageRule: 'vocabulary',
    threadKey: 't1',
    from: 'Riley Recruiter <riley@northwind-systems.example>',
    to: ['me@user.example'],
    subject: 'Staff engineer role',
    snippet: 'We are hiring a staff engineer and would like to talk.',
    sentAt: Date.UTC(2026, 9, 18),
    classification: 'solicitation',
    outreachKind: 'targeted',
    mismatchReason: null,
    confidence: 0.9,
    opportunityId: null,
    opportunityTitle: null,
    companyName: null,
    opportunityStage: null,
    needsReview: false,
    proposedTransition: null,
    createdAt: Date.UTC(2026, 9, 18),
    ...over,
  }) as CommunicationView;

describe('MessageDialog', () => {
  beforeEach(() => {
    mockApi({ 'GET /integrations/gmail': CONNECTED });
  });

  it('shows what was kept and links to the message itself, fetching no body', async () => {
    const { calls } = mockApi({ 'GET /integrations/gmail': CONNECTED });
    renderWithProviders(<MessageDialog comm={comm()} open={true} onOpenChange={vi.fn()} />);

    expect(await screen.findByText(/we are hiring a staff engineer/i)).toBeInTheDocument();
    const link = await screen.findByRole('link', { name: /read it in your mail/i });
    await waitFor(() =>
      expect(link).toHaveAttribute(
        'href',
        expect.stringContaining('authuser=mailbox%40gmail.test'),
      ),
    );
    expect(link).toHaveAttribute('href', expect.stringContaining('1a14802e3951170a'));
    // There is no body endpoint any more, and nothing should be asking for one.
    expect(calls.some((c) => c.path.endsWith('/body'))).toBe(false);
  });

  it('says plainly that this is all Opportun keeps', async () => {
    renderWithProviders(<MessageDialog comm={comm()} open={true} onOpenChange={vi.fn()} />);
    expect(
      await screen.findByText(/keeps this much of a message and no more/i),
    ).toBeInTheDocument();
  });

  it('#137: says why, instead of showing nothing, when the message cannot be addressed', async () => {
    // An Apple Mail message the connector identified by its own fallback id: there is no
    // Message-ID to open, and a link that opens nothing is worse than none.
    renderWithProviders(
      <MessageDialog
        comm={comm({ channel: 'apple_mail', externalId: 'apple-mail:mail-42' })}
        open={true}
        onOpenChange={vi.fn()}
      />,
    );
    await screen.findByText(/we are hiring a staff engineer/i);
    expect(screen.queryByRole('link')).toBeNull();
    expect(
      await screen.findByText('This message has no identifier the Mail app can open.'),
    ).toBeInTheDocument();
    // The closing sentence must not claim a mailbox copy that does not exist.
    expect(screen.queryByText(/is in your mailbox/i)).not.toBeInTheDocument();
  });

  it('#137: names LinkedIn specifically for a LinkedIn-sourced message, since that is what the owner hit', async () => {
    renderWithProviders(
      <MessageDialog
        comm={comm({ channel: 'linkedin', externalId: 'linkedin:1' })}
        open={true}
        onOpenChange={vi.fn()}
      />,
    );
    await screen.findByText(/we are hiring a staff engineer/i);
    expect(screen.queryByRole('link')).toBeNull();
    expect(
      await screen.findByText(
        'This came from your LinkedIn export, so there is no mailbox copy to open.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/is in your mailbox/i)).not.toBeInTheDocument();
  });

  it('#137: keeps the mailbox sentence when a link actually exists', async () => {
    renderWithProviders(<MessageDialog comm={comm()} open={true} onOpenChange={vi.fn()} />);
    expect(await screen.findByText(/is in your mailbox/i)).toBeInTheDocument();
  });

  it('falls back to saying there is no text, rather than showing an empty box', async () => {
    renderWithProviders(
      <MessageDialog comm={comm({ snippet: null })} open={true} onOpenChange={vi.fn()} />,
    );
    expect(await screen.findByText(/this message has no text/i)).toBeInTheDocument();
  });
});
