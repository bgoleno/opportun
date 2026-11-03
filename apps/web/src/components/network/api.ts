// The Network section's contacts (FR-C1) and referrals (FR-C3, C4): queries and mutations.
import type { ReferralStatus } from '@opportun/core';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { qk, type Page } from '@/lib/opportunities';

const enc = encodeURIComponent;

export interface ContactHistoryEntry {
  company: string;
  title: string | null;
  from: string | null;
  to: string | null;
}

export interface Contact {
  id: string;
  name: string;
  emails: string[];
  /** Metadata only: shown as a link the user may open; the app never fetches it. */
  linkedinUrl: string | null;
  currentCompanyId: string | null;
  currentCompanyName: string | null;
  history: ContactHistoryEntry[];
  strength: number | null;
  notes: string | null;
  source: 'manual' | 'linkedin_export' | 'capture';
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ContactReferral {
  activityId: string;
  opportunityId: string;
  opportunityTitle: string;
  companyName: string;
  status: ReferralStatus | null;
  occurredAt: number;
}

export type ContactDetail = Contact & { referrals: ContactReferral[] };

/** What the contact form writes; company is a name (mapped to a company by the server). */
export interface ContactInput {
  name?: string;
  emails?: string[];
  linkedinUrl?: string | null;
  company?: string | null;
  strength?: number | null;
  notes?: string | null;
  tags?: string[];
}

export interface ReferralCandidate {
  contactId: string;
  name: string;
  linkedinUrl: string | null;
  relation: 'current' | 'former';
  currentCompanyName: string | null;
  title: string | null;
  strength: number | null;
  rank: number | null;
  rationale: string | null;
}

export interface ReferralCandidates extends Page<ReferralCandidate> {
  ranked: boolean;
  aiUnavailable: string | null;
}

export interface OpportunityReferral {
  activityId: string;
  contactId: string;
  name: string;
  status: ReferralStatus | null;
  note: string | null;
  occurredAt: number;
}

/** The server's own cap (routes/common.ts MAX_LIMIT): the most a page can ever hold. */
export const CONTACTS_PAGE_SIZE = 200;

export const ck = {
  network: ['network'] as const,
  list: (q: string, page: number, pageSize: number) =>
    ['network', 'list', q, page, pageSize] as const,
  contact: (id: string) => ['network', 'detail', id] as const,
  candidates: (oppId: string) => ['referral-candidates', oppId] as const,
  referrals: (oppId: string) => ['referrals', oppId] as const,
};

/**
 * One page of up to `pageSize` contacts (CONTACTS_PAGE_SIZE unless a caller says otherwise;
 * issue #207): `page` is 0-based, and the query key includes `q`, `page` and the page size, so
 * a change to any is its own cache entry.
 * `keepPreviousData` keeps the outgoing page on screen while the new one loads, rather than
 * flashing to a loading state on every click.
 */
export function useContacts(q: string, page: number, pageSize: number = CONTACTS_PAGE_SIZE) {
  const query = q.trim();
  return useQuery({
    queryKey: ck.list(query, page, pageSize),
    queryFn: () =>
      api<Page<Contact>>(
        `/network?sort=name&limit=${pageSize}&offset=${page * pageSize}` +
          (query === '' ? '' : `&q=${enc(query)}`),
      ),
    placeholderData: keepPreviousData,
  });
}

export function useContact(id: string) {
  return useQuery({
    queryKey: ck.contact(id),
    queryFn: () => api<ContactDetail>(`/network/${enc(id)}`),
  });
}

export function useCreateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ContactInput & { name: string }) =>
      api<Contact>('/network', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ck.network }),
  });
}

export function useUpdateContact(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ContactInput) =>
      api<Contact>(`/network/${enc(id)}`, { method: 'PATCH', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ck.network }),
  });
}

export function useDeleteContact(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<null>(`/network/${enc(id)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ck.network }),
  });
}

export function useReferralCandidates(oppId: string) {
  return useQuery({
    queryKey: ck.candidates(oppId),
    queryFn: () => api<ReferralCandidates>(`/opportunities/${enc(oppId)}/referral-candidates`),
    // Ranking calls the model: keep the answer for the session unless something changes.
    staleTime: 10 * 60_000,
  });
}

export function useOpportunityReferrals(oppId: string) {
  return useQuery({
    queryKey: ck.referrals(oppId),
    queryFn: () => api<Page<OpportunityReferral>>(`/opportunities/${enc(oppId)}/referrals`),
  });
}

/** Refreshes what shows referral asks: the tab, the timeline, contact views. */
function useRefreshReferrals(oppId: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ck.referrals(oppId) }),
      qc.invalidateQueries({ queryKey: qk.timeline(oppId) }),
      qc.invalidateQueries({ queryKey: ck.network }),
      qc.invalidateQueries({ queryKey: qk.dashboard }),
    ]);
}

export function useAskReferral(oppId: string) {
  const refresh = useRefreshReferrals(oppId);
  return useMutation({
    mutationFn: (body: { contactId: string; note?: string }) =>
      api<{ id: string }>(`/opportunities/${enc(oppId)}/referrals`, { method: 'POST', body }),
    onSettled: refresh,
  });
}

/** Sets an ask's status, optimistically: the chip moves at once and rolls back on failure. */
export function useSetReferralStatus(oppId: string) {
  const qc = useQueryClient();
  const refresh = useRefreshReferrals(oppId);
  return useMutation({
    mutationFn: (v: { activityId: string; status: ReferralStatus }) =>
      api<unknown>(`/activities/${enc(v.activityId)}`, {
        method: 'PATCH',
        body: { referralStatus: v.status },
      }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ck.referrals(oppId) });
      const previous = qc.getQueryData<Page<OpportunityReferral>>(ck.referrals(oppId));
      if (previous !== undefined) {
        qc.setQueryData<Page<OpportunityReferral>>(ck.referrals(oppId), {
          ...previous,
          items: previous.items.map((r) =>
            r.activityId === v.activityId ? { ...r, status: v.status } : r,
          ),
        });
      }
      return { previous };
    },
    onError: (_err, _v, context) => {
      if (context?.previous !== undefined) {
        qc.setQueryData(ck.referrals(oppId), context.previous);
      }
    },
    onSettled: refresh,
  });
}
