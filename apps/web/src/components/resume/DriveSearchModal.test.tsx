import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { DriveSearchModal } from './DriveSearchModal';

const RECENT = {
  files: [
    {
      id: 'recent-1',
      name: 'Recently Edited Resume',
      modifiedTime: '2026-10-18T00:00:00.000Z',
      folderName: 'Resumes',
    },
  ],
};

describe('DriveSearchModal', () => {
  it('shows recently modified documents for an empty query, with the folder breadcrumb', async () => {
    mockApi({ 'GET /resumes/drive-search': RECENT });
    renderWithProviders(<DriveSearchModal open onOpenChange={() => {}} onPick={() => {}} />);
    expect(await screen.findByText('Recently Edited Resume')).toBeInTheDocument();
    expect(screen.getByText(/Resumes/)).toBeInTheDocument();
  });

  it('debounces typing: rapid keystrokes settle on one search, for the final value', async () => {
    // Real timers (not vi.useFakeTimers): the project's own history (issue #72) found that
    // faking time globally starves async machinery this test also depends on (React Query's
    // own scheduling here, a database driver there) of working timers. A real, short wait past
    // the debounce window is the safe way to prove this.
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /resumes/drive-search': (call: ApiCall) => ({
        files: call.search.includes('q=platform') ? RECENT.files : [],
      }),
    });
    renderWithProviders(<DriveSearchModal open onOpenChange={() => {}} onPick={() => {}} />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0)); // the initial empty-query search

    const input = screen.getByLabelText('Search');
    await user.type(input, 'platform');
    expect(await screen.findByText('Recently Edited Resume')).toBeInTheDocument();

    // Exactly one search for the typed term, not one per keystroke ("p", "pl", "pla", ...).
    const queryCalls = calls.filter((c) => c.path === '/resumes/drive-search');
    const forTerm = queryCalls.filter((c) => c.search.includes('q=platform'));
    expect(forTerm).toHaveLength(1);
  });

  it('distinguishes no match from a connection problem', async () => {
    mockApi({ 'GET /resumes/drive-search': { files: [] } });
    renderWithProviders(<DriveSearchModal open onOpenChange={() => {}} onPick={() => {}} />);
    expect(await screen.findByText('No documents found.')).toBeInTheDocument();
  });

  it('reports a Google connection problem distinctly from an empty result', async () => {
    mockApi({
      'GET /resumes/drive-search': () => ({
        status: 409,
        body: { error: { code: 'google_not_connected' } },
      }),
    });
    renderWithProviders(<DriveSearchModal open onOpenChange={() => {}} onPick={() => {}} />);
    expect(
      await screen.findByText('Connect your Google account in Settings > Integrations first.'),
    ).toBeInTheDocument();
  });

  it('loads the next page and keeps the first page’s results visible', async () => {
    mockApi({
      'GET /resumes/drive-search': (call: ApiCall) => {
        if (call.search.includes('pageToken=p2')) {
          return {
            files: [
              {
                id: 'page-2',
                name: 'Second Page Doc',
                modifiedTime: '2026-01-01T00:00:00.000Z',
                folderName: null,
              },
            ],
          };
        }
        return { files: RECENT.files, nextPageToken: 'p2' };
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<DriveSearchModal open onOpenChange={() => {}} onPick={() => {}} />);
    expect(await screen.findByText('Recently Edited Resume')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Second Page Doc')).toBeInTheDocument();
    expect(screen.getByText('Recently Edited Resume')).toBeInTheDocument();
  });

  it('picking a result hands it to onPick and closes the modal', async () => {
    mockApi({ 'GET /resumes/drive-search': RECENT });
    const onPick = vi.fn();
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<DriveSearchModal open onOpenChange={onOpenChange} onPick={onPick} />);
    await user.click(await screen.findByText('Recently Edited Resume'));
    expect(onPick).toHaveBeenCalledWith(RECENT.files[0]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
