// The budget-skip counts under Settings > AI usage (#210).
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { RankSkipsLine } from './RankSkips';

describe('RankSkipsLine', () => {
  it('says how many postings the budget kept from being ranked, today and over 7 days', async () => {
    mockApi({ 'GET /ai/usage/rank-skips': { today: 1, last7Days: 12 } });
    renderWithProviders(<RankSkipsLine />);
    expect(await screen.findByTestId('rank-skips')).toHaveTextContent(
      'Discovery ranking skipped because the daily budget was spent: 1 posting today, 12 postings in the last 7 days.',
    );
  });

  it('says zero plainly when nothing was skipped', async () => {
    mockApi({ 'GET /ai/usage/rank-skips': { today: 0, last7Days: 0 } });
    renderWithProviders(<RankSkipsLine />);
    expect(await screen.findByTestId('rank-skips')).toHaveTextContent(
      '0 postings today, 0 postings in the last 7 days',
    );
  });
});
