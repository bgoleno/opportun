// #137: OpenOriginal is shared by InboxRow, BlockedRow, MessageDialog and discovery's
// QueueDialogs. `explain` decides, per call site, whether showing nothing when no link can be
// built is the right answer (a row in a list) or the bug (a dialog the person opened on
// purpose). See blockedRow.test.tsx's "offers no link" tests for the explain=false default.
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { OpenOriginal } from './OpenOriginal';

const CONNECTED = {
  connected: true,
  lastSyncAt: null,
  count: 0,
  status: null,
  lookbackDays: 180,
  accountEmail: 'mailbox@gmail.test',
};

describe('OpenOriginal', () => {
  beforeEach(() => {
    mockApi({ 'GET /integrations/gmail': CONNECTED });
  });

  it('renders the link when one can be built, explain or not', async () => {
    renderWithProviders(<OpenOriginal comm={{ channel: 'gmail', externalId: 'abc123' }} explain />);
    expect(await screen.findByRole('link')).toBeInTheDocument();
    expect(screen.queryByText(/no identifier|LinkedIn export/)).not.toBeInTheDocument();
  });

  it('renders nothing by default when no link can be built', async () => {
    renderWithProviders(<OpenOriginal comm={{ channel: 'linkedin', externalId: 'linkedin:1' }} />);
    await Promise.resolve();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText(/LinkedIn export/)).not.toBeInTheDocument();
  });

  it('explains why, for a LinkedIn-sourced message, when asked to', async () => {
    renderWithProviders(
      <OpenOriginal comm={{ channel: 'linkedin', externalId: 'linkedin:1' }} explain />,
    );
    expect(
      await screen.findByText(
        'This came from your LinkedIn export, so there is no mailbox copy to open.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('explains why, for an Apple Mail fallback id, when asked to', async () => {
    renderWithProviders(
      <OpenOriginal comm={{ channel: 'apple_mail', externalId: 'apple-mail:mail-42' }} explain />,
    );
    expect(
      await screen.findByText('This message has no identifier the Mail app can open.'),
    ).toBeInTheDocument();
  });
});
