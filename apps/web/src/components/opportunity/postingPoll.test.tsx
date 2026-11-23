// The opportunity page asks for its posting every 3 s while it is being checked, and stops on the
// next read once the check has ended, however it ended (https://github.com/bgoleno/opportun/issues/869:
// a check whose job died now leaves `searching` as well).
import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithProviders } from '@/test/render';
import { useOpportunity } from './api';

afterEach(() => {
  vi.useRealTimers();
});

function Page() {
  const { data } = useOpportunity('o1');
  return <p>{data === undefined ? 'loading' : `${data.postingState}`}</p>;
}

describe('the poll of a posting being checked (#869)', () => {
  it('stops once the state leaves searching', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let state = 'searching';
    const { calls } = mockApi({
      'GET /opportunities/o1': () => ({ status: 200, body: { id: 'o1', postingState: state } }),
    });
    const reads = () => calls.filter((c) => c.path === '/opportunities/o1').length;
    renderWithProviders(<Page />);
    expect(await screen.findByText('searching')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(6_500));
    expect(reads()).toBe(3);

    state = 'needs_review';
    await act(() => vi.advanceTimersByTimeAsync(3_500));
    expect(screen.getByText('needs_review')).toBeInTheDocument();
    const after = reads();
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(reads()).toBe(after);
  });
});
