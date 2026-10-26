// MatchPanel.test.tsx exercises MatchPanelView, the pure presentational component, with a
// `view` handed to it directly. Nothing there mounts MatchPanel itself, the container that
// wires useMatchReport (a query) to the view, which is exactly the fetch-on-mount path
// navigating away and back exercises (issue #175: the match report used to live only in
// useScoreMatch's mutation state and vanished on navigation). This file closes that gap.
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { MatchPanel } from './MatchPanel';
import type { MatchReportView, Resume } from './api';

const RESUME: Resume = {
  id: 'r-1',
  kind: 'tailored',
  opportunityId: 'opp-1',
  title: 'Tailored Resume',
  store: 'google_doc',
  docRef: 'doc-1',
  url: null,
  parentResumeId: 'r-base',
  status: 'draft',
  submittedAt: null,
  submittedTo: null,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

const STORED_REPORT: MatchReportView = {
  report: {
    score: 81,
    missingKeywords: ['Kubernetes'],
    weakAreas: [{ area: 'Leadership', suggestion: 'Quantify the team size you led' }],
    summary: 'Strong backend match; infrastructure experience could be more specific.',
  },
  scoredAt: Date.parse('2026-10-01T00:00:00Z'),
  stale: false,
};

describe('MatchPanel (container)', () => {
  it('shows a previously stored report on mount, with no one clicking Score', async () => {
    const { calls } = mockApi({ 'GET /resumes/r-1/match': STORED_REPORT });
    renderWithProviders(<MatchPanel resume={RESUME} />);
    // The number itself now lives in MatchScoreHeader, not this container (issue #304).
    expect(await screen.findByLabelText('Match score')).toHaveValue(81);
    expect(
      screen.getByText('Strong backend match; infrastructure experience could be more specific.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Score again' })).toBeInTheDocument();
    const get = calls.find((c) => c.method === 'GET' && c.path === '/resumes/r-1/match');
    expect(new URLSearchParams(get?.search).get('opportunityId')).toBe('opp-1');
  });

  it('offers to score, not a stuck loading state, when nothing is stored yet', async () => {
    mockApi({ 'GET /resumes/r-1/match': null });
    renderWithProviders(<MatchPanel resume={RESUME} />);
    expect(await screen.findByRole('button', { name: 'Score match' })).toBeEnabled();
    expect(screen.queryByText(/\/ 100/)).toBeNull();
  });
});
