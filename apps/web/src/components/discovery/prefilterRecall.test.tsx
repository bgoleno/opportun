// The pre-filter's recall line on the Decided tab (#217).
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { PrefilterRecallLine, prefilterRecallText } from './PrefilterRecall';

describe('prefilterRecallText', () => {
  it('gives the figure with the count it is based on, and says it is only measuring', () => {
    expect(prefilterRecallText({ positives: 20, kept: 19, recall: 0.95 })).toBe(
      'Title pre-filter (measuring only, it filters nothing yet): it would have kept 19 of the 20 postings you accepted (95%).',
    );
    expect(prefilterRecallText({ positives: 1, kept: 0, recall: 0 })).toContain(
      'kept 0 of the 1 posting you accepted (0%)',
    );
  });

  it('with nothing accepted yet, gives no figure', () => {
    expect(prefilterRecallText({ positives: 0, kept: 0, recall: null })).toBe(
      'Title pre-filter (measuring only, it filters nothing yet): no accepted postings to measure it on yet.',
    );
  });
});

describe('PrefilterRecallLine', () => {
  it('shows what the server measured', async () => {
    mockApi({ 'GET /discovery/prefilter/recall': { positives: 4, kept: 3, recall: 0.75 } });
    renderWithProviders(<PrefilterRecallLine />);
    expect(await screen.findByTestId('prefilter-recall')).toHaveTextContent(
      'it would have kept 3 of the 4 postings you accepted (75%)',
    );
  });
});
