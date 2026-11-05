// The pre-filter's recall line on the Decided tab (#217).
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { useAcceptResult } from './api';
import { PrefilterCard, PrefilterRecallLine, prefilterRecallText } from './PrefilterRecall';

describe('prefilterRecallText', () => {
  it('gives the figure with the count it is based on, and says it is only measuring', () => {
    expect(prefilterRecallText({ positives: 20, kept: 19, recall: 0.95 })).toBe(
      'Title pre-filter (measuring only, new postings are not filtered): it would have kept 19 of the 20 job board postings you accepted (95%).',
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

  it('on, it no longer says it is only measuring', () => {
    const text = prefilterRecallText({ positives: 20, kept: 19, recall: 0.95, on: true });
    expect(text).not.toContain('measuring only');
    expect(text).toContain('on for your job boards');
    expect(text).toContain('19 of the 20');
  });

  it('with nothing accepted yet, gives no figure', () => {
    expect(prefilterRecallText({ positives: 0, kept: 0, recall: null })).toBe(
      'Title pre-filter (measuring only, new postings are not filtered): no accepted job board postings to measure it on yet.',
    );
  });
});

// #218: on, or why not, and what it saves.
describe('PrefilterCard', () => {
  const status = (over = {}) => ({
    positives: 0,
    kept: 0,
    recall: null,
    on: false,
    neededRecall: 0.95,
    neededPositives: 20,
    judged: 0,
    filtered: 0,
    ...over,
  });
  const card = async (over = {}) => {
    mockApi({ 'GET /discovery/prefilter/recall': status(over) });
    renderWithProviders(<PrefilterCard />);
    return await screen.findByTestId('prefilter-status');
  };

  it('with too few decided, says it is only measuring, and how many it needs', async () => {
    const line = await card({ positives: 8, kept: 8, recall: 1 });
    expect(line).toHaveTextContent(/measuring only/i);
    expect(line).toHaveTextContent('8 of the 20');
  });

  it('with enough decided and too few kept, says the figure and the bar', async () => {
    const line = await card({ positives: 20, kept: 18, recall: 0.9 });
    expect(line).toHaveTextContent(/measuring only/i);
    expect(line).toHaveTextContent('90%');
    expect(line).toHaveTextContent('95%');
  });

  it('with nothing decided, says so', async () => {
    expect(await card()).toHaveTextContent(/measuring only/i);
  });

  it('on: says so, and that the figure can read high from here', async () => {
    const line = await card({ positives: 20, kept: 19, recall: 0.95, on: true });
    expect(line).toHaveTextContent(/on for your job boards/i);
    expect(line).toHaveTextContent('95%');
    expect(screen.getByTestId('prefilter-caveat')).toHaveTextContent(/read high/i);
  });

  it('shows the share it would remove, in shadow mode as well', async () => {
    await card({ judged: 300, filtered: 240 });
    expect(screen.getByTestId('prefilter-share')).toHaveTextContent(
      'Of the 300 postings judged when they arrived, it would filter 240 (80%).',
    );
  });

  it('one posting reads as one', async () => {
    await card({ judged: 1, filtered: 1 });
    expect(screen.getByTestId('prefilter-share')).toHaveTextContent(
      'Of the 1 posting judged when it arrived, it would filter 1 (100%).',
    );
  });

  // qa: after falling back, cards still read "Filtered: title", so "nothing" would not be true.
  it('while measuring, it speaks of new postings, not of nothing', async () => {
    const line = await card({ positives: 20, kept: 18, recall: 0.9 });
    expect(line).toHaveTextContent('new postings are not filtered');
    expect(line).not.toHaveTextContent('nothing');
  });

  it('one that removes almost nothing reads as that', async () => {
    await card({ judged: 300, filtered: 3 });
    expect(screen.getByTestId('prefilter-share')).toHaveTextContent('(1%)');
  });

  it('with nothing judged yet, gives no share', async () => {
    await card();
    expect(screen.getByTestId('prefilter-share')).toHaveTextContent(/not judged a posting yet/i);
  });

  it('says job alerts are never filtered', async () => {
    await card();
    expect(screen.getByText(/job alert emails are never filtered/i)).toBeInTheDocument();
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
