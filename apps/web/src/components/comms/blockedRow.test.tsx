// C2: the blocked view is the escape hatch the consumer-domain veto ships enabled on top of.
// If a recruiter is filtered by mistake, this row is the only way to find out, so it has to
// name the sender, the date and the rule, and reach the original without Opportun storing it.
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import type { CommunicationView } from './api';
import { BlockedRow } from './BlockedRow';
import { mailLink, mailLinkMissingReason } from './mailLink';

/** The row asks for the Gmail status, to address its link at the synced mailbox. */
const CONNECTED = {
  connected: true,
  lastSyncAt: null,
  count: 0,
  status: null,
  lookbackDays: 180,
  accountEmail: 'mailbox@gmail.test',
};

const blocked = (over: Partial<CommunicationView> = {}): CommunicationView =>
  ({
    id: 'c1',
    channel: 'gmail',
    externalId: '1a14802e3951170a',
    triageDecision: 'filtered',
    triageRule: 'consumer_domain',
    threadKey: 't1',
    from: 'someone@gmail.com',
    to: ['me@user.example'],
    subject: null,
    snippet: null,
    sentAt: Date.UTC(2026, 9, 18),
    classification: null,
    outreachKind: null,
    mismatchReason: null,
    confidence: null,
    opportunityId: null,
    opportunityTitle: null,
    companyName: null,
    opportunityStage: null,
    needsReview: false,
    proposedTransition: null,
    createdAt: Date.UTC(2026, 9, 18),
    ...over,
  }) as CommunicationView;

describe('BlockedRow', () => {
  beforeEach(() => {
    mockApi({ 'GET /integrations/gmail': CONNECTED });
  });

  it('names the sender and which rule blocked it', async () => {
    renderWithProviders(<BlockedRow comm={blocked()} />);
    expect(await screen.findByText('someone@gmail.com')).toBeInTheDocument();
    expect(screen.getByText(/personal email provider/i)).toBeInTheDocument();
  });

  it('links to the original rather than showing any of its content', async () => {
    renderWithProviders(<BlockedRow comm={blocked()} />);
    const link = await screen.findByRole('link', { name: /open the original/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('1a14802e3951170a'));
    // Review Focus 4: the synced mailbox, not whichever Google account the browser lists first.
    // The address arrives with the status query, so the link is checked once it has.
    await waitFor(() =>
      expect(link).toHaveAttribute(
        'href',
        expect.stringContaining('authuser=mailbox%40gmail.test'),
      ),
    );
  });

  it('shows no subject or snippet, because none is stored', async () => {
    const { container } = renderWithProviders(<BlockedRow comm={blocked()} />);
    await screen.findByText('someone@gmail.com');
    expect(container.textContent).not.toMatch(/no subject/i);
    expect(container.textContent).not.toMatch(/Superbill/);
  });

  it('names a deny-list block distinctly from a consumer-domain one', async () => {
    renderWithProviders(<BlockedRow comm={blocked({ triageRule: 'deny_list' })} />);
    expect(await screen.findByText(/your deny list/i)).toBeInTheDocument();
  });

  it('says in words why each of the funnel rules dropped it', async () => {
    // A rule with no label here renders a bare identifier, which the blocked view exists to
    // avoid: this row is the only place a wrongly filtered message can be noticed.
    for (const [rule, words] of [
      ['private_content', /medical, financial or personal/i],
      ['vocabulary', /job wording/i],
      ['no_signal', /nothing in it about a job/i],
      ['ai_gate', /not part of the job search/i],
      ['thread', /linked to an opportunity/i],
      ['job_sender', /known job sender/i],
    ] as const) {
      const { container, unmount } = renderWithProviders(
        <BlockedRow comm={blocked({ triageRule: rule })} />,
      );
      await waitFor(() => expect(container.textContent, rule).toMatch(words));
      unmount();
    }
  });

  it('offers no link when the connector could not identify the message', async () => {
    renderWithProviders(
      <BlockedRow comm={blocked({ channel: 'apple_mail', externalId: 'apple-mail:mail-42' })} />,
    );
    await screen.findByText('someone@gmail.com');
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('mailLink', () => {
  it('opens a Gmail message by its own id', () => {
    const href = mailLink({ channel: 'gmail', externalId: 'abc123' });
    expect(href).toBe('https://mail.google.com/mail/u/0/#all/abc123');
  });

  it('addresses the right Google account when one is known', () => {
    const href = mailLink({ channel: 'gmail', externalId: 'abc123' }, 'me@user.example');
    expect(href).toContain('authuser=me%40user.example');
  });

  it('builds a message:// link from a real Apple Mail Message-ID', () => {
    const href = mailLink({ channel: 'apple_mail', externalId: 'apple-mail:x@mail.example' });
    expect(href).toBe('message://%3Cx%40mail.example%3E');
  });

  it('gives no link for the connector ids that are not Message-IDs', () => {
    // The connector falls back to these when Apple Mail has no Message-ID; a link built from
    // one would open nothing, which is worse than offering none.
    expect(mailLink({ channel: 'apple_mail', externalId: 'apple-mail:mail-42' })).toBeNull();
    expect(
      mailLink({ channel: 'apple_mail', externalId: 'apple-mail:sha256:deadbeef' }),
    ).toBeNull();
  });

  it('gives no link for a channel with nowhere to point', () => {
    expect(mailLink({ channel: 'linkedin', externalId: 'linkedin:1' })).toBeNull();
  });
});

describe('mailLinkMissingReason (issue #137)', () => {
  it('names LinkedIn specifically, since the person did not lose anything Opportun could have kept', () => {
    expect(mailLinkMissingReason({ channel: 'linkedin', externalId: 'linkedin:1' })).toBe(
      'This came from your LinkedIn export, so there is no mailbox copy to open.',
    );
  });

  it('explains the Apple Mail fallback-id case', () => {
    expect(mailLinkMissingReason({ channel: 'apple_mail', externalId: 'apple-mail:mail-42' })).toBe(
      'This message has no identifier the Mail app can open.',
    );
    expect(
      mailLinkMissingReason({ channel: 'apple_mail', externalId: 'apple-mail:sha256:deadbeef' }),
    ).toBe('This message has no identifier the Mail app can open.');
  });

  it('says nothing is wrong when mailLink actually has a link, so the two can never disagree', () => {
    expect(mailLink({ channel: 'gmail', externalId: 'abc123' })).not.toBeNull();
    expect(mailLinkMissingReason({ channel: 'gmail', externalId: 'abc123' })).toBeNull();
    expect(
      mailLink({ channel: 'apple_mail', externalId: 'apple-mail:x@mail.example' }),
    ).not.toBeNull();
    expect(
      mailLinkMissingReason({ channel: 'apple_mail', externalId: 'apple-mail:x@mail.example' }),
    ).toBeNull();
  });
});
