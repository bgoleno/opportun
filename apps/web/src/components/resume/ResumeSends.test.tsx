// The resume page's "Sent for" list (https://github.com/bgoleno/opportun/issues/158).
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { mockApi, renderWithProviders } from '@/test/render';
import { resumeErrorMessage, type ResumeSend } from './api';
import { ResumeSentFor } from './ResumeSends';

const send = (over: Partial<ResumeSend>): ResumeSend => ({
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
  ...over,
});

describe('ResumeSentFor', () => {
  it('lists every opportunity the resume was sent for, linked, with how and when', async () => {
    mockApi({
      'GET /resumes/r-base/sends': {
        items: [
          send({
            id: 's-2',
            opportunityId: 'opp-2',
            companyName: 'Initech',
            opportunityTitle: 'SRE',
            sentVia: 'LinkedIn',
          }),
          send({}),
        ],
      },
    });
    renderWithProviders(<ResumeSentFor resumeId="r-base" />);
    expect(await screen.findByRole('heading', { name: 'Sent for' })).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Initech: SRE', 'Acme: Staff Engineer']);
    expect(screen.getByText(/Sent via LinkedIn on/)).toBeInTheDocument();
    expect(screen.getByText(/Sent via Indeed on/)).toBeInTheDocument();
  });

  it('shows nothing for a resume never recorded as sent', async () => {
    const { calls } = mockApi({ 'GET /resumes/r-base/sends': { items: [] } });
    const { container } = renderWithProviders(<ResumeSentFor resumeId="r-base" />);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(container.textContent).toBe('');
  });

  it('explains the server refusals a send can meet', () => {
    const err = (code: string) => new ApiError(422, code);
    expect(resumeErrorMessage(err('resume_has_sends'))).toMatch(/Remove those records first/);
    expect(resumeErrorMessage(err('sent_at_in_future'))).toMatch(/not happened yet/);
    expect(resumeErrorMessage(err('resume_archived'))).toMatch(/archived/);
  });
});
