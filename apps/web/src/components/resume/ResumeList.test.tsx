import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import type { Resume } from './api';
import { ResumeList } from './ResumeList';

const draft: Resume = {
  id: 'r-draft',
  kind: 'base' as const,
  opportunityId: null,
  title: 'Base Resume',
  store: 'google_doc' as const,
  docRef: 'doc-1',
  url: null,
  parentResumeId: null,
  status: 'draft' as const,
  submittedAt: null,
  submittedTo: null,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

const submitted = {
  ...draft,
  id: 'r-submitted',
  title: 'Submitted Resume',
  kind: 'tailored' as const,
  opportunityId: 'opp-1',
  status: 'submitted' as const,
  submittedAt: 2,
  submittedTo: 'Acme careers',
  archivedAt: null,
};

const archived = {
  ...submitted,
  id: 'r-archived',
  title: 'Archived Resume',
  archivedAt: 3,
};

function withResumes(items: Resume[]) {
  return {
    'GET /resumes': { items, total: items.length },
    'GET /integrations/google': { connected: true, scopes: [] },
    'GET /settings/document-store': { store: 'google' },
  };
}

describe('ResumeList', () => {
  it('splits active and archived resumes into separate sections, archived marked', async () => {
    mockApi(withResumes([draft, archived]));
    renderWithProviders(<ResumeList />);
    expect(await screen.findByText('Base Resume')).toBeInTheDocument();
    const archivedRow = screen.getByText('Archived Resume').closest('tr');
    expect(archivedRow).not.toBeNull();
    expect(within(archivedRow!).getByText('Archived')).toBeInTheDocument();
    // Beyond the row's own badge, a section label separates it from the active table.
    expect(screen.getAllByText('Archived')).toHaveLength(2);
  });

  it('hard-deletes a resume that was never submitted', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      ...withResumes([draft]),
      'DELETE /resumes/r-draft': { outcome: 'deleted' },
    });
    renderWithProviders(<ResumeList />);
    await user.click(await screen.findByRole('button', { name: 'Delete Base Resume' }));
    expect(await screen.findByText('Delete this resume?')).toBeInTheDocument();
    expect(screen.getByText(/tailoring chat history/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await screen.findByText('Resume deleted');
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/resumes/r-draft')).toBe(true);
  });

  it('archives a submitted resume instead of deleting it, and the notice reports the server outcome', async () => {
    const user = userEvent.setup();
    mockApi({
      ...withResumes([submitted]),
      'DELETE /resumes/r-submitted': {
        outcome: 'archived',
        resume: { ...submitted, archivedAt: 99 },
      },
    });
    renderWithProviders(<ResumeList />);
    await user.click(await screen.findByRole('button', { name: 'Delete Submitted Resume' }));
    expect(await screen.findByText('Archive this resume?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(
      await screen.findByText(
        'This resume has been submitted and cannot be fully deleted. It has been archived. Archived resumes are still connected to the opportunity, but displayed separately.',
      ),
    ).toBeInTheDocument();
  });

  it('cancelling the dialog makes no request', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi(withResumes([draft]));
    renderWithProviders(<ResumeList />);
    await user.click(await screen.findByRole('button', { name: 'Delete Base Resume' }));
    await screen.findByText('Delete this resume?');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Delete this resume?')).not.toBeInTheDocument());
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('a failed delete stays open and visible rather than closing as if it worked', async () => {
    const user = userEvent.setup();
    mockApi({
      ...withResumes([draft]),
      'DELETE /resumes/r-draft': () => ({ status: 500, body: { error: { code: 'internal' } } }),
    });
    renderWithProviders(<ResumeList />);
    await user.click(await screen.findByRole('button', { name: 'Delete Base Resume' }));
    await screen.findByText('Delete this resume?');
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Delete this resume?')).toBeInTheDocument();
  });

  it('searching Drive and picking a result registers it the same way pasting a link does (#136)', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      ...withResumes([]),
      'GET /resumes/drive-search': {
        files: [
          {
            id: 'drive-doc-1',
            name: 'Platform Engineer Resume',
            modifiedTime: '2026-10-18T00:00:00.000Z',
            folderName: 'Resumes',
          },
        ],
      },
      'POST /resumes': { ...draft, id: 'r-new', title: 'Platform Engineer Resume' },
    });
    renderWithProviders(<ResumeList />);
    await user.click(await screen.findByRole('button', { name: 'Search Google Drive' }));
    await user.click(await screen.findByText('Platform Engineer Resume'));

    expect(await screen.findByText('Base resume registered')).toBeInTheDocument();
    const create = calls.find((c) => c.method === 'POST' && c.path === '/resumes');
    expect(create?.body).toEqual({ store: 'google_doc', docRef: 'drive-doc-1' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
