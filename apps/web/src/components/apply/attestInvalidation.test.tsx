// After "I submitted it", the resume views read again: the server records the send there
// (https://github.com/bgoleno/opportun/issues/158; tl on #164).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { rk } from '@/components/resume/api';
import { mockApi } from '@/test/render';
import { useAttestSubmission } from './api';

describe('useAttestSubmission', () => {
  it('invalidates the resume queries, the Resume tab sends included', async () => {
    mockApi({ 'POST /submissions/sub-1/attest': { id: 'sub-1', status: 'submitted' } });
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const list = rk.list({ opportunityId: 'opp-1' });
    const sends = rk.opportunitySends('opp-1');
    qc.setQueryData(list, { items: [], total: 0 });
    qc.setQueryData(sends, { items: [] });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useAttestSubmission('opp-1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'sub-1', moveToApplied: false });
    });
    await waitFor(() => expect(qc.getQueryState(list)?.isInvalidated).toBe(true));
    expect(qc.getQueryState(sends)?.isInvalidated).toBe(true);
  });
});
