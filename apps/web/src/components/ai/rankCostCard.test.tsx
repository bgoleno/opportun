// Settings > AI usage: discovery.rank over the last 7 and 30 days (#209). Made-up figures.
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { RankCostCard } from './RankCostCard';

const window = (days: number, over: Record<string, unknown> = {}) => ({
  days,
  calls: 0,
  errors: 0,
  inputTokens: null,
  outputTokens: null,
  avgCostUsd: null,
  totalCostUsd: 0,
  ...over,
});

describe('#209: the ranking cost card', () => {
  it('shows calls, errors, token spread, the ok-only average and the total for each window', async () => {
    mockApi({
      'GET /discovery/cost-figures': {
        rank: [
          window(7, {
            calls: 5,
            errors: 1,
            inputTokens: { median: 250, p90: 400 },
            outputTokens: { median: 25, p90: 40 },
            avgCostUsd: 0.0025,
            totalCostUsd: 0.0105,
          }),
          window(30, {
            calls: 6,
            errors: 1,
            inputTokens: { median: 300, p90: 1000 },
            outputTokens: { median: 30, p90: 100 },
            avgCostUsd: 0.004,
            totalCostUsd: 0.0205,
          }),
        ],
        sources: [],
      },
    });
    renderWithProviders(<RankCostCard />);
    const week = await screen.findByRole('row', { name: /last 7 days/i });
    expect(within(week).getByText('5 (1 error)')).toBeVisible();
    expect(within(week).getByText('250 / 400')).toBeVisible();
    expect(within(week).getByText('25 / 40')).toBeVisible();
    expect(within(week).getByText('$0.0025')).toBeVisible();
    expect(within(week).getByText('$0.0105')).toBeVisible();
    const month = screen.getByRole('row', { name: /last 30 days/i });
    expect(within(month).getByText('300 / 1,000')).toBeVisible();
    expect(within(month).getByText('$0.004')).toBeVisible();
  });

  it('with no calls, says so and never shows an invented figure', async () => {
    mockApi({ 'GET /discovery/cost-figures': { rank: [window(7), window(30)], sources: [] } });
    renderWithProviders(<RankCostCard />);
    const week = await screen.findByRole('row', { name: /last 7 days/i });
    expect(within(week).getAllByText('none')).toHaveLength(3);
    expect(within(week).getByText('0')).toBeVisible();
  });
});
