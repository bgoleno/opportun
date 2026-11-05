// Each review-queue sort order is cached as its own page under discoveryKeys.queue
// (https://github.com/bgoleno/opportun/issues/26), so an accept or dismiss has to update every
// cached order, not just one key, and a failure has to restore every one of them. A real
// QueryClient, seeded with both orders holding the same result.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import type { Page } from '@/lib/opportunities';
import { mockApi } from '@/test/render';
import {
  discoveryKeys,
  useAcceptResult,
  useBulkDismiss,
  useDismissResult,
  type DiscoveryResult,
} from './api';

const T0 = Date.parse('2026-10-20T12:00:00Z');
const RELEVANCE = [...discoveryKeys.queue, '-ai_score'];
const NEWEST = [...discoveryKeys.queue, '-createdAt'];

function result(id: string, aiScore: number, createdAt: number): DiscoveryResult {
  return {
    id,
    runId: 'run-1',
    sourceId: 'src-1',
    sourceKind: 'ats_greenhouse',
    roleTargetId: null,
    posting: { company: 'Initech', title: `Role ${id}`, postingUrl: null, location: null },
    dedupeKey: null,
    aiScore,
    aiRationale: null,
    rankSkipReason: null,
    rankDeferredAt: null,
    resolution: 'full',
    resolvedSourceRef: null,
    disposition: 'pending',
    opportunityId: null,
    sourceMailChannel: null,
    sourceMailExternalId: null,
    dismissReason: null,
    dismissNote: null,
    createdAt,
    updatedAt: createdAt,
  };
}

const TARGET = result('r-target', 90, T0 - 9 * 86_400_000);
const OTHER = result('r-other', 50, T0);

/** Both orders cached with the same two results, as after switching the sort once. */
function seeded() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  qc.setQueryData<Page<DiscoveryResult>>(RELEVANCE, { items: [TARGET, OTHER], total: 7 });
  qc.setQueryData<Page<DiscoveryResult>>(NEWEST, { items: [OTHER, TARGET], total: 7 });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

/** A response held until released, so the optimistic state can be read mid-flight. */
function held(response: () => unknown) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return { handler: async () => (await gate, response()), release };
}

describe('queue mutations across cached sort orders (#26)', () => {
  it('an accept drops the result from every cached order and lowers each total', async () => {
    const accept = held(() => ({ ...TARGET, disposition: 'accepted' }));
    mockApi({ 'POST /discovery/results/r-target/accept': accept.handler });
    const { qc, wrapper } = seeded();
    const { result: hook } = renderHook(() => useAcceptResult(), { wrapper });

    act(() => hook.current.mutate({ id: TARGET.id }));
    await waitFor(() => expect(qc.getQueryData(RELEVANCE)).toEqual({ items: [OTHER], total: 6 }));
    expect(qc.getQueryData(NEWEST)).toEqual({ items: [OTHER], total: 6 });
    accept.release();
    await waitFor(() => expect(hook.current.isSuccess).toBe(true));
  });

  it('a dismiss does the same', async () => {
    const dismiss = held(() => ({ ...TARGET, disposition: 'dismissed' }));
    mockApi({ 'POST /discovery/results/r-target/dismiss': dismiss.handler });
    const { qc, wrapper } = seeded();
    const { result: hook } = renderHook(() => useDismissResult(), { wrapper });

    act(() => hook.current.mutate({ id: TARGET.id }));
    await waitFor(() => expect(qc.getQueryData(RELEVANCE)).toEqual({ items: [OTHER], total: 6 }));
    expect(qc.getQueryData(NEWEST)).toEqual({ items: [OTHER], total: 6 });
    dismiss.release();
    await waitFor(() => expect(hook.current.isSuccess).toBe(true));
  });

  it('a failed accept restores every cached order exactly', async () => {
    const accept = held(() => ({ status: 500, body: { error: { code: 'internal' } } }));
    mockApi({ 'POST /discovery/results/r-target/accept': accept.handler });
    const { qc, wrapper } = seeded();
    const before = { relevance: qc.getQueryData(RELEVANCE), newest: qc.getQueryData(NEWEST) };
    const { result: hook } = renderHook(() => useAcceptResult(), { wrapper });

    act(() => hook.current.mutate({ id: TARGET.id }));
    // Removed from both first, so what follows is a rollback, not a removal that never happened.
    await waitFor(() => expect(qc.getQueryData(NEWEST)).toEqual({ items: [OTHER], total: 6 }));
    accept.release();
    await waitFor(() => expect(hook.current.isError).toBe(true));
    expect(qc.getQueryData(RELEVANCE)).toEqual(before.relevance);
    expect(qc.getQueryData(NEWEST)).toEqual(before.newest);
  });
});

describe('a queue decision refreshes the decided lists, even after the queue has gone (#139)', () => {
  // The Decided view may already be open (qa's in-app case on #139) or cached from an earlier
  // visit: when a dismiss or accept lands, both of its tabs must be read again. The mutation's
  // own options do this, so it still happens after the queue that started it has unmounted.
  const DECIDED = {
    dismissed: discoveryKeys.decided('dismissed'),
    accepted: discoveryKeys.decided('accepted'),
  };

  function seededWithDecided() {
    const seed = seeded();
    seed.qc.setQueryData<Page<DiscoveryResult>>(DECIDED.dismissed, { items: [], total: 0 });
    seed.qc.setQueryData<Page<DiscoveryResult>>(DECIDED.accepted, { items: [], total: 0 });
    return seed;
  }

  const invalidated = (qc: QueryClient, key: readonly unknown[]) =>
    qc.getQueryState(key)?.isInvalidated === true;

  it.each([
    ['a dismiss', 'dismiss', () => useDismissResult()],
    ['an accept', 'accept', () => useAcceptResult()],
  ] as const)('%s that settles after the queue unmounted', async (_n, verb, useHook) => {
    const held1 = held(() => ({
      ...TARGET,
      disposition: verb === 'dismiss' ? 'dismissed' : 'accepted',
    }));
    mockApi({ [`POST /discovery/results/r-target/${verb}`]: held1.handler });
    const { qc, wrapper } = seededWithDecided();
    const { result: hook, unmount } = renderHook(useHook, { wrapper });

    act(() => hook.current.mutate({ id: TARGET.id }));
    await waitFor(() => expect(qc.getQueryData(RELEVANCE)).toEqual({ items: [OTHER], total: 6 }));
    unmount();
    expect(invalidated(qc, DECIDED.dismissed)).toBe(false);
    held1.release();
    await waitFor(() => expect(invalidated(qc, DECIDED.dismissed)).toBe(true));
    expect(invalidated(qc, DECIDED.accepted)).toBe(true);
  });

  it('a bulk dismiss that settles after the queue unmounted', async () => {
    const bulk = held(() => ({ results: [{ id: TARGET.id, outcome: 'dismissed' }] }));
    mockApi({ 'POST /discovery/results/bulk-dismiss': bulk.handler });
    const { qc, wrapper } = seededWithDecided();
    const { result: hook, unmount } = renderHook(() => useBulkDismiss(), { wrapper });

    act(() => hook.current.mutate({ ids: [TARGET.id], reason: 'industry' }));
    unmount();
    bulk.release();
    await waitFor(() => expect(invalidated(qc, DECIDED.dismissed)).toBe(true));
    expect(invalidated(qc, DECIDED.accepted)).toBe(true);
  });
});
