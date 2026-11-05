// Settings > AI puts the ranking cost card and the refused-rank line on the page
// (https://github.com/bgoleno/opportun/issues/211): each component has its own tests, and these
// pin that the page renders them. Made-up figures.
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { Route } from './ai';

const AiSettings = Route.options.component!;

const week = (days: number) => ({
  days,
  calls: 4,
  errors: 0,
  inputTokens: null,
  outputTokens: null,
  avgCostUsd: null,
  totalCostUsd: 0,
});

describe('Settings > AI (#211)', () => {
  it('shows the ranking cost card and the refused-rank line, once each', async () => {
    mockApi({
      'GET /discovery/cost-figures': { rank: [week(7), week(30)], sources: [] },
      'GET /ai/usage/rank-skips': { today: 2, last7Days: 3 },
    });
    renderWithProviders(<AiSettings />);
    await screen.findByRole('table', { name: 'Discovery ranking cost' });
    expect(screen.getAllByRole('table', { name: 'Discovery ranking cost' })).toHaveLength(1);
    // The figures, not the wording, which #214 changes.
    const line = await screen.findByTestId('rank-skips');
    expect(line).toHaveTextContent(/\b2\b.*today.*\b3\b.*last 7 days/);
    expect(screen.getAllByTestId('rank-skips')).toHaveLength(1);
  });
});
