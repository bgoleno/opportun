// The recorded confirmation page's evidence card, and deleting it
// (https://github.com/bgoleno/opportun/issues/121).
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { formatDateTime } from '@/lib/opportunities';
import { mockApi, renderWithProviders } from '@/test/render';
import type { SubmissionView } from './api';
import { PageEvidence } from './PageEvidence';

const RECORDED = Date.parse('2026-10-30T09:15:00');
const URL_ = 'https://boards.greenhouse.io/examplecorp/jobs/123/confirmation';

const confirmed = {
  id: 'sub-1',
  opportunityId: 'opp-1',
  status: 'confirmed',
  confirmationKind: 'page',
  confirmedAt: RECORDED,
  confirmationEmail: null,
  confirmationPage: {
    activityId: 'act-1',
    url: URL_,
    host: 'boards.greenhouse.io',
    recordedAt: RECORDED,
    text: 'Thank you for applying!\n<b>We</b> will be in touch.',
  },
} as unknown as SubmissionView;

describe('PageEvidence', () => {
  it('shows where and when the page was recorded, and its text as plain text', async () => {
    const user = userEvent.setup();
    mockApi({});
    renderWithProviders(<PageEvidence attempt={confirmed} />);
    const link = await screen.findByRole('link', { name: 'boards.greenhouse.io' });
    expect(link).toHaveAttribute('href', URL_);
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText(formatDateTime(RECORDED))).toBeInTheDocument();
    await user.click(screen.getByText('Show the recorded text'));
    // The site's markup is shown as typed, never rendered.
    expect(screen.getByText(/<b>We<\/b> will be in touch\./)).toBeInTheDocument();
    expect(document.querySelector('b')).toBeNull();
  });

  it('deletes the recorded page after asking, through the timeline entry', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'DELETE /activities/act-1': () => ({ status: 204, body: null }),
    });
    renderWithProviders(<PageEvidence attempt={confirmed} />);
    await user.click(await screen.findByRole('button', { name: 'Delete the recorded page' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete the recorded page?' });
    expect(within(dialog).getByText(/This application stays confirmed\./)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await screen.findByRole('button', { name: 'Delete the recorded page' });
    expect(
      calls.filter((c) => c.method === 'DELETE' && c.path === '/activities/act-1'),
    ).toHaveLength(1);
  });

  it('a page whose recorded copy was deleted says so', async () => {
    mockApi({});
    renderWithProviders(
      <PageEvidence attempt={{ ...confirmed, confirmationPage: null } as SubmissionView} />,
    );
    expect(
      await screen.findByText(
        'A confirmation page backed this up. Its recorded copy has been deleted.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a link that is not http(s) is shown as text, never as a link', async () => {
    mockApi({});
    const odd = {
      ...confirmed,
      confirmationPage: { ...confirmed.confirmationPage!, url: 'javascript:alert(1)', host: null },
    } as SubmissionView;
    renderWithProviders(<PageEvidence attempt={odd} />);
    expect(await screen.findByText('(unknown site)')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
