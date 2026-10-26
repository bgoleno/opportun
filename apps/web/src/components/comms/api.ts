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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
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
function filterKey(f: InboxFilters): string {
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

export function useInbox(view: InboxTab, filters: InboxFilters = {}) {
  return useQuery({
    queryKey: [...ck.view(view), filterKey(filters)] as const,
    queryFn: () =>
      api<Page<CommunicationView>>(`/communications?view=${view}&limit=200${filterQuery(filters)}`),
  });
}

export interface BulkTriageResult {
  succeeded: number;
  skipped: number;
}

// Reject only: bulk reclassify is not exposed server-side (see routes/communications.ts).
export type BulkAction = { kind: 'reject'; reason: RejectPayload['reason']; note?: string | null };

/** Apply one triage action to a selection of messages (#inbox-sort-filter-bulk). */
export function useBulkTriage() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (v: { ids: string[]; action: BulkAction }) =>
      api<BulkTriageResult>('/communications/bulk', { method: 'POST', body: v }),
    onSettled: refresh,
  });
}

export function useOpportunityCommunications(opportunityId: string) {
  return useQuery({
    queryKey: ck.opportunity(opportunityId),
    queryFn: () =>
      api<Page<CommunicationView>>(
        `/communications?view=all&opportunityId=${enc(opportunityId)}&limit=200`,
      ),
  });
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
    mutationFn: (v: { id: string; input: RejectPayload }) =>
      api<RejectResult>(`/communications/${enc(v.id)}/reject`, { method: 'POST', body: v.input }),
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

export function useGmailStatus() {
  return useQuery({ queryKey: ck.gmail, queryFn: () => api<GmailStatus>('/integrations/gmail') });
}

export function useGmailSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ jobId: string }>('/integrations/gmail/sync', { method: 'POST' }),
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
