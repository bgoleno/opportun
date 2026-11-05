// The pre-filter's recall line on the Decided tab (#217).
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { useAcceptResult } from './api';
import { PrefilterRecallLine, prefilterRecallText } from './PrefilterRecall';

describe('prefilterRecallText', () => {
  it('gives the figure with the count it is based on, and says it is only measuring', () => {
    expect(prefilterRecallText({ positives: 20, kept: 19, recall: 0.95 })).toBe(
      'Title pre-filter (measuring only, it filters nothing yet): it would have kept 19 of the 20 job board postings you accepted (95%).',
    );
    expect(prefilterRecallText({ positives: 1, kept: 0, recall: 0 })).toContain(
      'kept 0 of the 1 job board posting you accepted (0%)',
    );
  });

  it('rounds down, so only every posting kept reads as 100%', () => {
    expect(prefilterRecallText({ positives: 200, kept: 199, recall: 0.995 })).toContain('(99%)');
    expect(prefilterRecallText({ positives: 38, kept: 36, recall: 36 / 38 })).toContain('(94%)');
    expect(prefilterRecallText({ positives: 100, kept: 29, recall: 0.29 })).toContain('(29%)');
    expect(prefilterRecallText({ positives: 20, kept: 20, recall: 1 })).toContain('(100%)');
  });

  it('with nothing accepted yet, gives no figure', () => {
    expect(prefilterRecallText({ positives: 0, kept: 0, recall: null })).toBe(
      'Title pre-filter (measuring only, it filters nothing yet): no accepted job board postings to measure it on yet.',
    );
  });
});

describe('PrefilterRecallLine', () => {
  it('shows what the server measured', async () => {
    mockApi({ 'GET /discovery/prefilter/recall': { positives: 4, kept: 3, recall: 0.75 } });
    renderWithProviders(<PrefilterRecallLine />);
    expect(await screen.findByTestId('prefilter-recall')).toHaveTextContent(
      'it would have kept 3 of the 4 job board postings you accepted (75%)',
    );
  });

  it('accepting a result refreshes it, and each visit asks again', async () => {
    let positives = 0;
    mockApi({
      'GET /discovery/prefilter/recall': () => ({ positives, kept: positives, recall: 1 }),
      'POST /discovery/results/r1/accept': () => {
        positives = 1;
        return { id: 'r1' };
      },
      'GET /discovery/results': { items: [], total: 0 },
      'GET /opportunities': { items: [], total: 0 },
    });
    function Accepting() {
      const accept = useAcceptResult();
      return (
        <>
          <PrefilterRecallLine />
          <button onClick={() => accept.mutate({ id: 'r1' })}>accept</button>
        </>
      );
    }
    renderWithProviders(<Accepting />);
    await screen.findByTestId('prefilter-recall');
    fireEvent.click(screen.getByRole('button', { name: 'accept' }));
    await waitFor(() =>
      expect(screen.getByTestId('prefilter-recall')).toHaveTextContent('kept 1 of the 1'),
    );
  });
});
