// Sync now after Google was disconnected elsewhere (https://github.com/bgoleno/opportun/issues/896):
// the server's sentence is shown, and stays while the card turns to the disconnected state.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { GmailCard } from './integrations';

const SENTENCE = 'Gmail is not connected. Connect it in Settings > Integrations, then sync again.';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

it('says why, and shows the card as disconnected', async () => {
  let connected = true;
  const { calls } = mockApi({
    'GET /integrations/google': () => ({
      clientConfigured: true,
      connected,
      scopes: connected ? [SCOPE] : [],
    }),
    'GET /integrations/gmail': () => ({
      status: 200,
      body: {
        connected,
        accountEmail: null,
        count: 3,
        lastSyncAt: null,
        status: null,
        pendingClassify: 0,
        lookbackDays: 180,
      },
    }),
    'POST /integrations/gmail/sync': () => {
      connected = false;
      return { status: 409, body: { error: { code: 'gmail_not_connected', message: SENTENCE } } };
    },
  });
  const user = userEvent.setup();
  renderWithProviders(<GmailCard />);
  await user.click(await screen.findByRole('button', { name: 'Sync now' }));
  expect(await screen.findByText('Grant read-only Gmail access to start.')).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull());
  expect(screen.getByRole('alert')).toHaveTextContent(SENTENCE);
  // The Google card on the same page is brought up to date too.
  await waitFor(() =>
    expect(calls.filter((c) => c.path === '/integrations/google').length).toBeGreaterThan(1),
  );
});
