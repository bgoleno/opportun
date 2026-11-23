// Inbox data: communication views, the user's corrections and
// accepted stage proposals, and Gmail sync status. Shapes mirror
// apps/server/src/routes/communications.ts and integrationsMail.ts.
import type {
  BodySource,
  CommChannel,
  CommClassification,
  OpportunityStage,
  OutreachKind,
} from '@opportun/core';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api } from '@/lib/api';
import { INBOX_FILTER_MAX } from './limits';
import type { RejectPayload } from './RejectForm';
import { qk, type OpportunityView, type Page } from '@/lib/opportunities';

export interface CommunicationView {
  id: string;
  channel: CommChannel;
  threadKey: string | null;
  from: string;
  to: string[];
  subject: string | null;
  snippet: string | null;
  sentAt: number;
  classification: CommClassification | null;
  outreachKind: OutreachKind | null;
  mismatchReason: string | null;
  confidence: number | null;
  /** What the classifier actually read (issue #149); null for a message never classified, or
   * classified before this column existed. */
  bodySource: BodySource | null;
  opportunityId: string | null;
  opportunityTitle: string | null;
  companyName: string | null;
  opportunityStage: OpportunityStage | null;
  needsReview: boolean;
  proposedTransition: OpportunityStage | null;
  createdAt: number;
  /** The provider's own id, which mailLink turns into a deep link to the original. */
  externalId: string;
  /** Stage 1's verdict and the rule that reached it (spec D6); null for older rows. */
  triageDecision: string | null;
  triageRule: string | null;
}

export const INBOX_TABS = ['needs_review', 'linked', 'spam', 'filtered', 'blocked'] as const;
export type InboxTab = (typeof INBOX_TABS)[number];

export interface GmailStatus {
  connected: boolean;
  lastSyncAt: number | null;
  count: number;
  status: string | null;
  /** The sync window in days; null when the gmail_query setting was hand-edited. */
  lookbackDays: number | null;
  /**
   * The synced mailbox's address, which a deep link needs so that it opens THAT mailbox and not
   * whichever Google account the browser lists first. Null until a sync has read the profile.
   */
  accountEmail: string | null;
  /** This user's messages still being classified (#645); the Inbox reads on until it is 0. */
  pendingClassify?: number;
}

export interface ReclassifyInput {
  classification?: CommClassification;
  outreachKind?: OutreachKind | null;
  opportunityId?: string | null;
}

const enc = encodeURIComponent;

export const ck = {
  all: ['communications'] as const,
  view: (view: InboxTab) => ['communications', 'view', view] as const,
  opportunity: (id: string) => ['communications', 'opportunity', id] as const,
  gmail: ['integrations', 'gmail'] as const,
};

const CHANNEL_LABELS = new Map<CommChannel, string>([
  ['gmail', 'Gmail'],
  ['apple_mail', 'Apple Mail'],
  ['linkedin', 'LinkedIn'],
]);

/** Where a message came from, as the Inbox labels it. */
export const channelLabel = (c: CommChannel): string => CHANNEL_LABELS.get(c) ?? c;

const CLASSIFICATION_LABELS = new Map<CommClassification, string>([
  ['solicitation', 'Outreach'],
  ['scheduling', 'Scheduling'],
  ['follow_up', 'Follow-up'],
  ['rejection', 'Rejection'],
  ['offer', 'Offer'],
  ['networking', 'Networking'],
  ['other', 'Other'],
]);

const OUTREACH_LABELS = new Map<OutreachKind, string>([
  ['targeted', 'Targeted'],
  ['broadcast_spam', 'Broadcast'],
  ['irrelevant', 'Not a fit'],
]);

export const classificationLabel = (c: CommClassification): string =>
  CLASSIFICATION_LABELS.get(c) ?? c;
export const outreachLabel = (k: OutreachKind): string => OUTREACH_LABELS.get(k) ?? k;

/** Triage controls applied to a view: source, sender, keyword, and date order. */
export interface InboxFilters {
  channel?: CommChannel | undefined;
  sender?: string | undefined;
  q?: string | undefined;
  order?: 'newest' | 'oldest' | undefined;
}

/** A stable, serializable key for a filter set, so each distinct filter caches on its own. */
export function filterKey(f: InboxFilters): string {
  return JSON.stringify({
    channel: f.channel ?? null,
    sender: f.sender?.trim() ?? '',
    q: f.q?.trim() ?? '',
    order: f.order ?? 'newest',
  });
}

function filterQuery(f: InboxFilters): string {
  const parts: string[] = [];
  if (f.channel) parts.push(`channel=${enc(f.channel)}`);
  const sender = f.sender?.trim();
  if (sender) parts.push(`sender=${enc(sender)}`);
  const q = f.q?.trim();
  if (q) parts.push(`q=${enc(q)}`);
  if (f.order === 'oldest') parts.push('order=oldest');
  return parts.length > 0 ? `&${parts.join('&')}` : '';
}

/** The typed filters that are too long to send (#894), by the names the Inbox gives them. */
export function tooLongFilters(f: InboxFilters): ('keyword' | 'sender')[] {
  const over = (v: string | undefined) => (v?.trim().length ?? 0) > INBOX_FILTER_MAX;
  return [
    ...(over(f.q) ? (['keyword'] as const) : []),
    ...(over(f.sender) ? (['sender'] as const) : []),
  ];
}

/**
 * A page of a tab, with what it answers (#894): the page on screen can be an older one, while the
 * next loads or after it failed, and what is said about the rows has to be about that one.
 */
export interface InboxPageView extends Page<CommunicationView> {
  page: number;
  filters: string;
}

/** One page of a tab: the server's cap (routes/common.ts MAX_LIMIT), and so the most it returns. */
export const INBOX_PAGE = 200;

/**
 * One page of a tab (#646): `page` is 0-based. Each page is its own cache entry under the view's
 * key, so a refresh of the view refreshes every page. The page on screen stays while the next
 * loads, rather than flashing to a loading state.
 */
export function useInbox(
  view: InboxTab,
  filters: InboxFilters = {},
  page = 0,
  pageSize: number = INBOX_PAGE,
) {
  return useQuery({
    queryKey: [...ck.view(view), filterKey(filters), page, pageSize] as const,
    queryFn: async (): Promise<InboxPageView> => ({
      ...(await api<Page<CommunicationView>>(
        `/communications?view=${view}&limit=${pageSize}&offset=${page * pageSize}` +
          filterQuery(filters),
      )),
      page,
      filters: filterKey(filters),
    }),
    // Never sent: the server would only refuse it (#894). The Inbox says so instead.
    enabled: tooLongFilters(filters).length === 0,
    // The rows on screen stay while the next page or a new filter loads (#646, #678): without
    // them the selection, and a confirmation open for it, would be dropped for that moment.
    placeholderData: keepPreviousData,
  });
}

export interface BulkTriageResult {
  succeeded: number;
  skipped: number;
  /** Linked differently since the user saw them (#666); left untouched. */
  changed: number;
}

// Reject only: bulk reclassify is not exposed server-side (see routes/communications.ts).
export type BulkAction = { kind: 'reject'; reason: RejectPayload['reason']; note?: string | null };

/** Apply one triage action to a selection of messages (#inbox-sort-filter-bulk). */
export function useBulkTriage() {
  const refresh = useRefresh();
  return useMutation({
    // Each message with the link it was seen under (#666): the server leaves a changed one alone.
    mutationFn: (v: {
      items: { id: string; opportunityId: string | null }[];
      action: BulkAction;
    }) => api<BulkTriageResult>('/communications/bulk', { method: 'POST', body: v }),
    onSettled: refresh,
  });
}

/** The server's cap on one page of a thread, and the size of each page after it (#422). */
export const THREAD_PAGE = 200;

/**
 * The pages of a thread held so far, joined: each message once, by id, and the thread's total as
 * the newest page reports it (#422). Pages are asked for by offset, so a message linked between
 * two of them moves the next page back a row (one message twice) and one unlinked moves it on (one
 * skipped); `changed` says the pages' totals differ, the sign that this may have happened.
 */
export function joinThreadPages(pages: readonly Page<CommunicationView>[]): {
  items: CommunicationView[];
  total: number;
  changed: boolean;
} {
  const seen = new Set<string>();
  const items: CommunicationView[] = [];
  for (const page of pages) {
    for (const c of page.items) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      items.push(c);
    }
  }
  const total = pages.at(-1)?.total ?? items.length;
  return { items, total, changed: pages.some((p) => p.total !== pages[0]?.total) };
}

/**
 * An opportunity's linked messages in `order` (#394). The server applies its 200 cap after
 * ordering, so a long thread asked for newest first is its newest messages; the next page
 * carries on from there in the same order (#422). While the other order loads, the pages already
 * held stay available (`isPlaceholderData`): the tab shows them re-sorted only when they are the
 * whole thread, and a loading line otherwise.
 *
 * When the pages held report different totals, the thread changed between them, so the pages it
 * holds are asked for again from the start, in the same order (the infinite query's own refetch).
 * That happens at most once for each set of totals seen, so a thread that keeps changing cannot
 * make it ask forever. One message linked and another unlinked between two pages leaves the
 * totals equal and is not seen; repeats are still dropped by `joinThreadPages`.
 */
export function useOpportunityCommunications(
  opportunityId: string,
  order: 'newest' | 'oldest' = 'newest',
) {
  const query = useInfiniteQuery({
    queryKey: [...ck.opportunity(opportunityId), order] as const,
    queryFn: ({ pageParam }) =>
      api<Page<CommunicationView>>(
        `/communications?view=all&opportunityId=${enc(opportunityId)}&order=${order}&limit=${THREAD_PAGE}${pageParam === 0 ? '' : `&offset=${pageParam}`}`,
      ),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      // An offset counts rows as the server holds them, repeats included.
      const held = pages.reduce((n, p) => n + p.items.length, 0);
      // An empty page ends it too, so a thread that shrank meanwhile cannot ask forever.
      return last.items.length > 0 && held < last.total ? held : undefined;
    },
    placeholderData: keepPreviousData,
  });
  const { data, isPlaceholderData, isFetching, refetch } = query;
  const totals =
    data && !isPlaceholderData && joinThreadPages(data.pages).changed
      ? `${order}:${data.pages.map((p) => p.total).join(',')}`
      : null;
  const refetchedFor = useRef<string | null>(null);
  useEffect(() => {
    if (totals === null || isFetching || refetchedFor.current === totals) return;
    refetchedFor.current = totals;
    void refetch();
  }, [totals, isFetching, refetch]);
  return query;
}

/** Refreshes every view a communication change can touch. */
function useRefresh() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ck.all }),
      qc.invalidateQueries({ queryKey: qk.dashboard }),
      qc.invalidateQueries({ queryKey: qk.opportunities }),
      qc.invalidateQueries({ queryKey: ['opportunity'] }),
    ]);
}

export function useReclassify() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (v: { id: string; input: ReclassifyInput }) =>
      api<CommunicationView>(`/communications/${enc(v.id)}/classify`, {
        method: 'POST',
        body: v.input,
      }),
    onSettled: refresh,
  });
}

/**
 * The envelope address of a From header, for display and for naming what gets blocked. The
 * display name is attacker-controlled, so only the angle-addr that ENDS the header counts.
 */
export function senderAddress(from: string): string {
  const lt = from.lastIndexOf('<');
  const gt = from.lastIndexOf('>');
  return lt !== -1 && gt > lt ? from.slice(lt + 1, gt).trim() : from.trim();
}

/** What POST /communications/:id/reject answers; see routes/communications.ts. */
export interface RejectResult {
  /** Null when neverIngest was not asked for; true only once a deny rule is confirmed active. */
  blocked: boolean | null;
  blockFailureReason?: 'unparseable_sender';
}

/** Reject as out of scope (spec D4): there is no message left to show, just whether the
 *  block the user may have asked for actually took (#145). */
export function useReject() {
  const refresh = useRefresh();
  return useMutation({
    // With the link the message was seen under (#666): the server refuses if it changed since.
    mutationFn: (v: { id: string; input: RejectPayload; expectedOpportunityId: string | null }) =>
      api<RejectResult>(`/communications/${enc(v.id)}/reject`, {
        method: 'POST',
        body: { ...v.input, expectedOpportunityId: v.expectedOpportunityId },
      }),
    onSettled: refresh,
  });
}

export function useAcceptTransition() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (v: { id: string; reopen: boolean }) =>
      api<{ communication: CommunicationView; opportunityId: string; stage: OpportunityStage }>(
        `/communications/${enc(v.id)}/accept-transition`,
        { method: 'POST', body: v.reopen ? { reopen: true } : {} },
      ),
    onSettled: refresh,
  });
}

export function useDismissProposal() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) =>
      api<CommunicationView>(`/communications/${enc(id)}/proposed-transition`, {
        method: 'DELETE',
      }),
    onSettled: refresh,
  });
}

/** Opportunities matching a search, for the link picker. */
export function useOpportunitySearch(q: string) {
  const term = q.trim();
  return useQuery({
    queryKey: ['opportunities', { q: term, picker: true }],
    enabled: term.length > 0,
    queryFn: () =>
      api<Page<OpportunityView>>(`/opportunities?q=${enc(term)}&limit=10&sort=-updatedAt`),
  });
}

/** When Sync now was pressed, kept beside the status so every reader of it sees one value. */
const SYNC_WATCH_KEY = ['integrations', 'gmail-sync-watch'] as const;
/** How often the status is read while a sync's mail is on its way, and for how long at most. */
const SYNC_POLL_MS = 2500;
const SYNC_WATCH_MAX_MS = 2 * 60_000;

/**
 * Whether the mail a Sync now asked for may still be on its way (#645): the sync has not reported
 * since the click, it is running, or messages from it are still being classified. Never past
 * SYNC_WATCH_MAX_MS, so a sync that never reports does not poll for good.
 */
function syncInFlight(status: GmailStatus | undefined, since: number | undefined): boolean {
  if (since === undefined || Date.now() - since > SYNC_WATCH_MAX_MS) return false;
  if (status === undefined) return true;
  return (
    status.status === 'running' ||
    (status.lastSyncAt ?? 0) < since ||
    (status.pendingClassify ?? 0) > 0
  );
}

export function useGmailStatus() {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ck.gmail,
    queryFn: () => api<GmailStatus>('/integrations/gmail'),
    // Read again while a sync's mail is on its way, then stop (#645).
    refetchInterval: (q) =>
      syncInFlight(q.state.data, qc.getQueryData<number>(SYNC_WATCH_KEY)) ? SYNC_POLL_MS : false,
  });
}

/**
 * Each new Gmail status can mean new or newly classified mail: the message lists and their counts
 * are read again, so they show without a reload or a tab switch (#645). Called once, by the
 * Inbox's sync control, never by every reader of the status: each row's Open original reads it
 * too, and one refresh per reader cost (rows + 1) times the list reads (qa on #668).
 */
export function useGmailSyncRefresh() {
  const qc = useQueryClient();
  const { data } = useGmailStatus();
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (data === undefined) return;
    const now = `${data.lastSyncAt ?? ''}|${data.count}|${data.pendingClassify ?? ''}|${data.status ?? ''}`;
    if (seen.current !== null && seen.current !== now) {
      void qc.invalidateQueries({ queryKey: ck.all });
    }
    seen.current = now;
  }, [data, qc]);
}

export function useGmailSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ jobId: string }>('/integrations/gmail/sync', { method: 'POST' }),
    onSuccess: () => qc.setQueryData(SYNC_WATCH_KEY, Date.now()),
    onSettled: () => qc.invalidateQueries({ queryKey: ck.gmail }),
  });
}

export function useSetGmailLookback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (days: number) =>
      api<{ lookbackDays: number }>('/integrations/gmail/lookback', {
        method: 'PUT',
        body: { days },
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ck.gmail }),
  });
}
