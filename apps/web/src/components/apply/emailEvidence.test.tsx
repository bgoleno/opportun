// The email confirmation's evidence card and its unlink (https://github.com/bgoleno/opportun/issues/119).
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { formatDateTime } from '@/lib/opportunities';
import { mockApi, renderWithProviders } from '@/test/render';
import type { SubmissionView } from './api';
import { EmailEvidence, signalSummary } from './EmailEvidence';

const SENT = Date.parse('2026-10-30T09:15:00');

const confirmed = {
  id: 'sub-1',
  opportunityId: 'opp-1',
  status: 'confirmed',
  confirmationKind: 'email',
  confirmedAt: SENT + 60_000,
  confirmationEmail: {
    communicationId: 'comm-1',
    subject: 'Application received',
    fromAddress: 'careers@examplecorp.example',
    sentAt: SENT,
    signals: ['sender_domain', 'role_and_company', 'time_window'],
  },
} as unknown as SubmissionView;

describe('EmailEvidence', () => {
  it('shows the subject, the address, when, and what it matched on, in words', async () => {
    mockApi({});
    renderWithProviders(<EmailEvidence attempt={confirmed} />);
    expect(await screen.findByText('Application received')).toBeInTheDocument();
    expect(screen.getByText('careers@examplecorp.example')).toBeInTheDocument();
    expect(screen.getByText(formatDateTime(SENT))).toBeInTheDocument();
    expect(
      screen.getByText(
        "the sender's address is at the company's domain; the role and the company are named; sent soon after you applied",
      ),
    ).toBeInTheDocument();
  });

  it('unlinks after asking, through the single-id route', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'POST /submissions/sub-1/unlink-confirmation': () => ({
        status: 200,
        body: {
          ...confirmed,
          status: 'submitted',
          confirmationKind: null,
          confirmationEmail: null,
        },
      }),
    });
    renderWithProviders(<EmailEvidence attempt={confirmed} />);
    await user.click(await screen.findByRole('button', { name: 'Not this application (unlink)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unlink this email?' });
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Unlink' }));
    await screen.findByRole('button', { name: 'Not this application (unlink)' });
    expect(calls.filter((c) => c.path === '/submissions/sub-1/unlink-confirmation')).toHaveLength(
      1,
    );
  });

  it('every signal has words of its own', () => {
    expect(signalSummary(['ats_job_ref', 'ats_board'])).toBe(
      "this job's id in a link; the company's job board in a link",
    );
  });
});
