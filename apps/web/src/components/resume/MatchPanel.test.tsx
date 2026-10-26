import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MatchPanelView, MatchScoreHeader, type MatchPanelViewProps } from './MatchPanel';
import type { MatchReportView } from './api';

const REPORT: MatchReportView = {
  report: {
    score: 72,
    missingKeywords: ['Terraform'],
    weakAreas: [{ area: 'Kubernetes', suggestion: 'Name the clusters you ran' }],
    summary: 'Strong Go background; show infrastructure work.',
  },
  scoredAt: Date.parse('2026-10-01T00:00:00Z'),
  stale: false,
};

function setup(overrides: Partial<MatchPanelViewProps> = {}) {
  const props: MatchPanelViewProps = {
    opportunityId: 'opp-1',
    view: null,
    scoring: false,
    error: null,
    onScore: vi.fn(),
    ...overrides,
  };
  render(<MatchPanelView {...props} />);
  return props;
}

describe('MatchPanelView', () => {
  it('a base resume with no opportunity cannot be scored', () => {
    setup({ opportunityId: null });
    expect(screen.queryByRole('button', { name: /score/i })).toBeNull();
    expect(screen.getByText(/not linked to a job/)).toBeInTheDocument();
  });

  it('a never-scored resume offers to score, with no report shown', () => {
    setup({ view: null });
    expect(screen.getByRole('button', { name: 'Score match' })).toBeEnabled();
    expect(screen.queryByText(/\/ 100/)).toBeNull();
  });

  it('the initial fetch disables scoring until it resolves', () => {
    setup({ view: undefined });
    expect(screen.getByRole('button', { name: 'Loading...' })).toBeDisabled();
  });

  it('a scored, current report shows the score, dated, with no staleness notice', () => {
    setup({ view: REPORT });
    expect(screen.getByRole('button', { name: 'Score again' })).toBeInTheDocument();
    // The number itself now lives in MatchScoreHeader (issue #304); this view encodes it in
    // the meter and names the band in words.
    expect(screen.getByLabelText('Match score')).toHaveValue(72);
    expect(screen.getByText('Strong match')).toBeInTheDocument();
    expect(screen.getByText('Strong Go background; show infrastructure work.')).toBeInTheDocument();
    expect(screen.getByText('Terraform')).toBeInTheDocument();
    expect(screen.getByText('Kubernetes')).toBeInTheDocument();
    expect(screen.getByText(/No tailoring session has completed/)).toBeInTheDocument();
    expect(screen.queryByText('May be outdated')).toBeNull();
    expect(screen.queryByText(/may no longer reflect/)).toBeNull();
  });

  it('a stale report says plainly that the document may have changed since', () => {
    setup({ view: { ...REPORT, stale: true } });
    // The old score still renders: it is not hidden, only honestly dated (#175).
    expect(screen.getByLabelText('Match score')).toHaveValue(72);
    expect(screen.getByText('May be outdated')).toBeInTheDocument();
    expect(screen.getByText(/may no longer reflect the current document/)).toBeInTheDocument();
  });

  it('scoring in progress disables the button and relabels it', () => {
    setup({ view: REPORT, scoring: true });
    expect(screen.getByRole('button', { name: 'Scoring...' })).toBeDisabled();
  });

  it('clicking the button requests a score', async () => {
    const user = userEvent.setup();
    const props = setup({ view: null });
    await user.click(screen.getByRole('button', { name: 'Score match' }));
    expect(props.onScore).toHaveBeenCalled();
  });

  it('shows a server error alongside the button', () => {
    setup({ error: new Error('boom') });
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('the report is expanded by default and can be collapsed and reopened', async () => {
    const user = userEvent.setup();
    setup({ view: REPORT });
    expect(screen.getByText('Strong Go background; show infrastructure work.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /hide details/i }));
    expect(
      screen.queryByText('Strong Go background; show infrastructure work.'),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /show details/i }));
    expect(screen.getByText('Strong Go background; show infrastructure work.')).toBeInTheDocument();
  });

  it('reopens automatically when a new report replaces a collapsed one', async () => {
    const user = userEvent.setup();
    const props: MatchPanelViewProps = {
      opportunityId: 'opp-1',
      view: REPORT,
      scoring: false,
      error: null,
      onScore: vi.fn(),
    };
    const { rerender } = render(<MatchPanelView {...props} />);
    await user.click(screen.getByRole('button', { name: /hide details/i }));
    expect(screen.queryByText(REPORT.report.summary)).not.toBeInTheDocument();

    const rescored: MatchReportView = { ...REPORT, scoredAt: REPORT.scoredAt + 1000 };
    rerender(<MatchPanelView {...props} view={rescored} />);
    expect(screen.getByText(REPORT.report.summary)).toBeInTheDocument();
  });
});

describe('MatchScoreHeader', () => {
  it('renders nothing when there is no report yet', () => {
    render(<MatchScoreHeader view={null} />);
    expect(screen.queryByText(/\/ 100/)).toBeNull();
  });

  it('renders nothing while the stored report is still loading', () => {
    render(<MatchScoreHeader view={undefined} />);
    expect(screen.queryByText(/\/ 100/)).toBeNull();
  });

  it('shows the score and band once scored, with no stale indicator', () => {
    render(<MatchScoreHeader view={REPORT} />);
    expect(screen.getByText('72')).toBeInTheDocument();
    expect(screen.getByText(/Strong match/)).toBeInTheDocument();
    expect(screen.queryByText('May be outdated')).toBeNull();
  });

  it('flags a stale score the same way the report does', () => {
    render(<MatchScoreHeader view={{ ...REPORT, stale: true }} />);
    expect(screen.getByText('72')).toBeInTheDocument();
    expect(screen.getByText('May be outdated')).toBeInTheDocument();
  });
});
