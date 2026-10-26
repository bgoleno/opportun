import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import type { Resume } from './api';
import { OpportunityResumeTab } from './OpportunityResumeTab';

const archivedResume: Resume = {
  id: 'r-archived',
  kind: 'tailored' as const,
  opportunityId: 'opp-1',
  title: 'Archived Tailored Resume',
  store: 'google_doc' as const,
  docRef: 'doc-1',
  url: null,
  parentResumeId: 'r-base',
  status: 'submitted' as const,
  submittedAt: 1,
  submittedTo: 'Acme careers',
  archivedAt: 2,
  createdAt: 1,
  updatedAt: 1,
};

const unattachedResume: Resume = {
  ...archivedResume,
  id: 'r-free',
  title: 'Unattached Tailored Resume',
  opportunityId: null,
  status: 'draft' as const,
  submittedAt: null,
  submittedTo: null,
  archivedAt: null,
};

/** Routes the one `GET /resumes` key to the right list by query string, like the server does. */
function resumeRoutes(opts: {
  forOpportunity?: (typeof archivedResume)[];
  all?: (typeof archivedResume)[];
}) {
  return {
    'GET /resumes': (call: ApiCall) => {
      if (call.search.includes('opportunityId')) {
        return { items: opts.forOpportunity ?? [], total: (opts.forOpportunity ?? []).length };
      }
      if (call.search.includes('kind=base')) return { items: [], total: 0 };
      return { items: opts.all ?? [], total: (opts.all ?? []).length };
    },
    'GET /integrations/google': { connected: true, scopes: [] },
    'GET /settings/document-store': { store: 'google' },
  };
}

describe('OpportunityResumeTab', () => {
  it('still shows an archived resume for its opportunity, marked, not filtered out', async () => {
    mockApi(resumeRoutes({ forOpportunity: [archivedResume] }));
    renderWithProviders(<OpportunityResumeTab opportunityId="opp-1" />);
    const row = await screen.findByText('Archived Tailored Resume');
    const li = row.closest('li');
    expect(li).not.toBeNull();
    expect(li!.textContent).toContain('Archived');
    expect(li!.textContent).toContain('Submitted');
  });

  it('attaches an existing, unattached resume picked from the list', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      ...resumeRoutes({ all: [unattachedResume] }),
      'PATCH /resumes/r-free': { ...unattachedResume, opportunityId: 'opp-1' },
    });
    renderWithProviders(<OpportunityResumeTab opportunityId="opp-1" />);
    await screen.findByText('Unattached Tailored Resume (Tailored)');
    await user.click(screen.getByRole('button', { name: 'Attach' }));
    await screen.findByText('Resume attached');
    expect(
      calls.some(
        (c) =>
          c.method === 'PATCH' &&
          c.path === '/resumes/r-free' &&
          (c.body as { opportunityId?: string }).opportunityId === 'opp-1',
      ),
    ).toBe(true);
  });

  it('registers and attaches a new document link in one step', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      ...resumeRoutes({}),
      'POST /resumes': { ...unattachedResume, id: 'r-new', opportunityId: 'opp-1' },
    });
    renderWithProviders(<OpportunityResumeTab opportunityId="opp-1" />);
    const input = await screen.findByLabelText('Google Doc link');
    await user.type(input, 'https://docs.google.com/document/d/NewDoc/edit');
    await user.click(screen.getByRole('button', { name: 'Register and attach' }));
    await screen.findByText('Resume registered and attached');
    const call = calls.find((c) => c.method === 'POST' && c.path === '/resumes');
    expect(call?.body).toMatchObject({ opportunityId: 'opp-1' });
  });

  it('detaches a resume from this opportunity', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      ...resumeRoutes({ forOpportunity: [unattachedResume] }),
      'PATCH /resumes/r-free': { ...unattachedResume, opportunityId: null },
    });
    renderWithProviders(<OpportunityResumeTab opportunityId="opp-1" />);
    await user.click(
      await screen.findByRole('button', {
        name: 'Remove Unattached Tailored Resume from this opportunity',
      }),
    );
    await screen.findByText('Resume removed from this opportunity');
    expect(
      calls.some(
        (c) =>
          c.method === 'PATCH' &&
          c.path === '/resumes/r-free' &&
          (c.body as { opportunityId?: string | null }).opportunityId === null,
      ),
    ).toBe(true);
  });
});
