// The refusal counts under Settings > AI usage (#210, relabelled by #214: refusals, not postings).
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { RankSkipsLine } from './RankSkips';

describe('RankSkipsLine', () => {
  it('counts refusals, not postings, today and over 7 days', async () => {
    mockApi({ 'GET /ai/usage/rank-skips': { today: 1, last7Days: 12 } });
    renderWithProviders(<RankSkipsLine />);
    expect(await screen.findByTestId('rank-skips')).toHaveTextContent(
      'Ranking calls refused by the per-task daily limit: 1 time today, 12 times in the last 7 days. One posting can be refused more than once.',
    );
  });

  it('says zero plainly when nothing was refused', async () => {
    mockApi({ 'GET /ai/usage/rank-skips': { today: 0, last7Days: 0 } });
    renderWithProviders(<RankSkipsLine />);
    expect(await screen.findByTestId('rank-skips')).toHaveTextContent(
      '0 times today, 0 times in the last 7 days',
    );
  });
});
