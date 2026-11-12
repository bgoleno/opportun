// The switch for the nightly network probe in Settings > AI (#296): it shows what the server says
// (on by default, which the server decides), sec's sentence under it, and a change saved for the
// user.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { NetworkBoardCheckCard } from './NetworkBoardCheck';

const LABEL = 'Check job boards for companies in my network';

describe('NetworkBoardCheckCard', () => {
  it('shows the setting on, as the server reads it by default, with what it sends and to whom', async () => {
    mockApi({ 'GET /settings/network-board-check': { enabled: true } });
    renderWithProviders(<NetworkBoardCheckCard />);
    const box = await screen.findByRole('checkbox', { name: LABEL });
    await waitFor(() => expect(box).toBeEnabled());
    expect(box).toBeChecked();
    expect(box).toHaveAccessibleDescription(
      'Each night, Opportun looks up as many as 20 of these companies on Greenhouse, Lever and Ashby by name. Those services see the names it tries, which come from where your contacts work, and your server’s address. No contact’s name or details are sent.',
    );
  });

  it('shows off when the server reads off', async () => {
    mockApi({ 'GET /settings/network-board-check': { enabled: false } });
    renderWithProviders(<NetworkBoardCheckCard />);
    const box = await screen.findByRole('checkbox', { name: LABEL });
    await waitFor(() => expect(box).toBeEnabled());
    expect(box).not.toBeChecked();
  });

  it('turns it off, and on again', async () => {
    const user = userEvent.setup();
    let stored = true;
    const { calls } = mockApi({
      'GET /settings/network-board-check': () => ({ status: 200, body: { enabled: stored } }),
      'PUT /settings/network-board-check': (req: { body: { enabled: boolean } }) => {
        stored = req.body.enabled;
        return { status: 200, body: { enabled: stored } };
      },
    });
    renderWithProviders(<NetworkBoardCheckCard />);
    const box = await screen.findByRole('checkbox', { name: LABEL });
    await waitFor(() => expect(box).toBeEnabled());
    await user.click(box);
    await waitFor(() => expect(box).not.toBeChecked());
    await waitFor(() => expect(box).toBeEnabled());
    await user.click(box);
    await waitFor(() => expect(box).toBeChecked());
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
      { enabled: false },
      { enabled: true },
    ]);
  });

  it('a refused save says why, and the box stays as it was', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /settings/network-board-check': { enabled: false },
      'PUT /settings/network-board-check': () => ({
        status: 500,
        body: { error: { code: 'internal', message: 'Something went wrong' } },
      }),
    });
    renderWithProviders(<NetworkBoardCheckCard />);
    const box = await screen.findByRole('checkbox', { name: LABEL });
    await waitFor(() => expect(box).toBeEnabled());
    await user.click(box);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(box).not.toBeChecked();
  });
});
