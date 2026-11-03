import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders, type ApiCall } from '@/test/render';
import { rk, type Resume, type ResumeSend } from './api';
import { OpportunityResumeTab } from './OpportunityResumeTab';
import { sentAtFor } from './ResumeSends';

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
  sends?: ResumeSend[];
}) {
  return {
    'GET /opportunities/opp-1/resume-sends': { items: opts.sends ?? [] },
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

// https://github.com/bgoleno/opportun/issues/158: a base resume is recorded as sent, never
// attached, and is listed for the opportunity with its send.
const baseResume: Resume = {
  ...unattachedResume,
  id: 'r-base',
  kind: 'base' as const,
  title: 'Jane Base Resume',
  parentResumeId: null,
};

const sentBase: ResumeSend = {
  id: 'send-1',
  opportunityId: 'opp-1',
  opportunityTitle: 'Staff Engineer',
  companyName: 'Acme',
  resumeId: 'r-base',
  resumeTitle: 'Jane Base Resume',
  resumeKind: 'base',
  sentAt: Date.parse('2026-10-30T12:00:00'),
  sentVia: 'Indeed',
  submissionId: null,
  createdAt: 1,
};

describe('OpportunityResumeTab: recording a base resume as sent (#158)', () => {
  it('offers "Record as sent" for a base, not Attach, and posts the resume and how it was sent', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      ...resumeRoutes({ all: [baseResume] }),
      'POST /opportunities/opp-1/resume-sends': sentBase,
    });
    renderWithProviders(<OpportunityResumeTab opportunityId="opp-1" />);
    await screen.findByText('Jane Base Resume (Base)');
    expect(screen.queryByRole('button', { name: 'Attach' })).not.toBeInTheDocument();
    const recordButton = screen.getByRole('button', { name: 'Record as sent' });
    // Nothing to record until it says how.
    expect(recordButton).toBeDisabled();
    await user.type(screen.getByLabelText('Sent via'), 'Indeed');
    await user.click(recordButton);
    await screen.findByText('Recorded as sent');
    const post = calls.find(
      (c) => c.method === 'POST' && c.path === '/opportunities/opp-1/resume-sends',
    );
    // Today: no time sent, so the server records "now". Never a PATCH of the base.
    expect(post?.body).toEqual({ resumeId: 'r-base', sentVia: 'Indeed' });
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('a tailored resume in the same list is still attached', async () => {
    mockApi(resumeRoutes({ all: [unattachedResume, baseResume] }));
    renderWithProviders(<OpportunityResumeTab opportunityId="opp-1" />);
    await screen.findByText('Unattached Tailored Resume (Tailored)');
    expect(screen.getByRole('button', { name: 'Attach' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record as sent' })).not.toBeInTheDocument();
  });

  it('lists a send under "Resumes for this opportunity", marked as a base, and removes it', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      ...resumeRoutes({ sends: [sentBase] }),
      'DELETE /opportunities/opp-1/resume-sends/send-1': () => ({ status: 204 }),
    });
    renderWithProviders(<OpportunityResumeTab opportunityId="opp-1" />);
    const link = await screen.findByRole('link', { name: 'Jane Base Resume' });
    const li = link.closest('li')!;
    expect(li.textContent).toContain('Base resume');
    expect(li.textContent).toContain('Sent via Indeed on');
    await user.click(
      screen.getByRole('button', { name: 'Remove the record that Jane Base Resume was sent' }),
    );
    await screen.findByText('Sent record removed');
    expect(
      calls.some(
        (c) => c.method === 'DELETE' && c.path === '/opportunities/opp-1/resume-sends/send-1',
      ),
    ).toBe(true);
  });

  it('a past day is sent as midday that day, local time; today is left to the server', () => {
    expect(sentAtFor('2026-11-02', '2026-11-02')).toBeUndefined();
    const at = new Date(sentAtFor('2026-10-30', '2026-11-02')!);
    expect([at.getFullYear(), at.getMonth() + 1, at.getDate(), at.getHours()]).toEqual([
      2026, 10, 30, 12,
    ]);
  });

  // #172 item 5 (qa and tl on #164): the refreshed list drops the removed row, and its button
  // with it. The toasts sat in that button's own mutate() callbacks, which React Query does not
  // call once their component has unmounted, so whether one showed was a race the user mostly
  // lost. These tests fix the order: the DELETE is held, the row leaves the list, then it answers.
  function heldRemoval(answer: { status: number; body?: unknown }) {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let removed = false;
    const api = mockApi({
      ...resumeRoutes({}),
      'GET /opportunities/opp-1/resume-sends': () => ({ items: removed ? [] : [sentBase] }),
      'DELETE /opportunities/opp-1/resume-sends/send-1': async () => {
        removed = true; // gone on the server (or, for a failure, removed by another tab)
        await held;
        return answer;
      },
    });
    return { api, release };
  }

  async function removeWhileTheRowLeaves(answer: { status: number; body?: unknown }) {
    const user = userEvent.setup();
    const { api, release } = heldRemoval(answer);
    const { queryClient } = renderWithProviders(<OpportunityResumeTab opportunityId="opp-1" />);
    await user.click(
      await screen.findByRole('button', {
        name: 'Remove the record that Jane Base Resume was sent',
      }),
    );
    await waitFor(() => expect(api.calls.some((c) => c.method === 'DELETE')).toBe(true));
    await queryClient.invalidateQueries({ queryKey: rk.opportunitySends('opp-1') });
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'Jane Base Resume' })).not.toBeInTheDocument(),
    );
    release();
  }

  it('says the record was removed, though its row (and button) left the list first', async () => {
    await removeWhileTheRowLeaves({ status: 204 });
    expect(await screen.findByText('Sent record removed')).toBeInTheDocument();
  });

  it('says a removal failed, and why, though its row left the list first', async () => {
    await removeWhileTheRowLeaves({
      status: 409,
      body: { error: { code: 'conflict', message: 'Something changed' } },
    });
    expect(await screen.findByText('Could not remove the record')).toBeInTheDocument();
  });
});
