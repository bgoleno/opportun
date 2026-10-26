// Queries and mutations for one opportunity's detail page.
import type { Activity, ActivityKind, NextStep, NormalizedPosting } from '@opportun/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import {
  qk,
  type AttachmentMeta,
  type OpportunityView,
  type Page,
  type TimelineItem,
} from '@/lib/opportunities';

const enc = encodeURIComponent;

export function useOpportunity(id: string) {
  return useQuery({
    queryKey: qk.opportunity(id),
    queryFn: () => api<OpportunityView>(`/opportunities/${enc(id)}`),
  });
}

export function useTimeline(id: string) {
  return useQuery({
    queryKey: qk.timeline(id),
    queryFn: () => api<Page<TimelineItem>>(`/opportunities/${enc(id)}/timeline?limit=200`),
  });
}

export function useNextSteps(id: string) {
  return useQuery({
    queryKey: qk.nextSteps(id),
    queryFn: () => api<Page<NextStep>>(`/opportunities/${enc(id)}/next-steps?limit=200`),
  });
}

export function useAttachments(id: string) {
  return useQuery({
    queryKey: qk.attachments(id),
    queryFn: () => api<Page<AttachmentMeta>>(`/opportunities/${enc(id)}/attachments?limit=200`),
  });
}

/** Invalidates everything that shows this opportunity (detail, lists, dashboard). */
function useRefresh(id: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qk.opportunity(id) }),
      qc.invalidateQueries({ queryKey: qk.opportunities }),
      qc.invalidateQueries({ queryKey: qk.dashboard }),
    ]);
}

/** The opportunity fields the detail page can change in place (FR-O1). */
export interface OpportunityPatch {
  priority?: number;
  descriptionMd?: string | null;
  postingUrl?: string | null;
  location?: string | null;
  remote?: boolean | null;
  compNote?: string | null;
}

export function useUpdateOpportunity(id: string) {
  const qc = useQueryClient();
  const refresh = useRefresh(id);
  return useMutation({
    mutationFn: (patch: OpportunityPatch) =>
      api<OpportunityView>(`/opportunities/${enc(id)}`, { method: 'PATCH', body: patch }),
    onSuccess: (opp) => qc.setQueryData(qk.opportunity(id), opp),
    onSettled: refresh,
  });
}

/**
 * Clears a possible-duplicate flag between `id` and `otherId` (#9): a "not a duplicate"
 * judgement persisted server-side, not just hidden in this tab until the next page load.
 */
export function useDismissPossibleDuplicate(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (otherId: string) =>
      api<OpportunityView>(`/opportunities/${enc(id)}/dismiss-duplicate`, {
        method: 'POST',
        body: { otherId },
      }),
    onSuccess: (opp) => qc.setQueryData(qk.opportunity(id), opp),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.opportunities }),
  });
}

/**
 * Merges `otherId` into `keepId` (FR-O7): the server moves the other's children onto the kept
 * opportunity, keeps the more advanced stage and deletes the other. Resolves with the kept one.
 */
export function useMergeOpportunity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ keepId, otherId }: { keepId: string; otherId: string }) =>
      api<OpportunityView>(`/opportunities/${enc(keepId)}/merge`, {
        method: 'POST',
        body: { otherId },
      }),
    onSuccess: (opp) => qc.setQueryData(qk.opportunity(opp.id), opp),
    onSettled: (_res, _err, { keepId }) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['opportunity', keepId] }),
        qc.invalidateQueries({ queryKey: qk.opportunities }),
        qc.invalidateQueries({ queryKey: qk.dashboard }),
        qc.invalidateQueries({ queryKey: ['communications'] }),
      ]),
  });
}

export interface ActivityInput {
  kind: ActivityKind;
  title: string;
  bodyMd?: string;
  participants?: string[];
  externalUrl?: string;
  occurredAt?: number;
}

export function useCreateActivity(id: string) {
  const refresh = useRefresh(id);
  return useMutation({
    mutationFn: (body: ActivityInput) =>
      api<Activity>(`/opportunities/${enc(id)}/activities`, { method: 'POST', body }),
    onSuccess: refresh,
  });
}

export function useDeleteActivity(id: string) {
  const refresh = useRefresh(id);
  return useMutation({
    mutationFn: (activityId: string) =>
      api<void>(`/activities/${enc(activityId)}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
}

export function useCreateNextStep(id: string) {
  const refresh = useRefresh(id);
  return useMutation({
    mutationFn: (body: { action: string; dueAt: number | null }) =>
      api<NextStep>(`/opportunities/${enc(id)}/next-steps`, { method: 'POST', body }),
    onSuccess: refresh,
  });
}

export function useToggleNextStep(id: string) {
  const refresh = useRefresh(id);
  return useMutation({
    mutationFn: (v: { stepId: string; done: boolean }) =>
      api<NextStep>(`/next-steps/${enc(v.stepId)}`, { method: 'PATCH', body: { done: v.done } }),
    onSettled: refresh,
  });
}

export function useDeleteNextStep(id: string) {
  const refresh = useRefresh(id);
  return useMutation({
    mutationFn: (stepId: string) => api<void>(`/next-steps/${enc(stepId)}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
}

export function useUploadAttachment(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file, file.name);
      return api<AttachmentMeta>(`/opportunities/${enc(id)}/attachments`, {
        method: 'POST',
        body: form,
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.attachments(id) }),
  });
}

export function useDeleteAttachment(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (attachmentId: string) =>
      api<void>(`/attachments/${enc(attachmentId)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.attachments(id) }),
  });
}

// --- posting (FR-O1) -------------------------------------------------------------

export interface PostingCandidateView {
  posting: NormalizedPosting;
  /** Title overlap with the opportunity, 0 to 1. */
  score: number;
  /** Locations of the sibling postings this candidate stands for. */
  otherLocations: string[];
}

/** What POST /opportunities/:id/find-posting answers; see routes/opportunityPosting.ts. */
export interface FindPostingResult {
  outcome: 'attached' | 'candidates' | 'none' | 'no_board';
  /** Present when the outcome is 'attached'. */
  opportunity?: OpportunityView;
  candidate?: PostingCandidateView;
  /** Confident candidates ('candidates'), or the ranked board ('none'). */
  candidates?: PostingCandidateView[];
  /** The ranked board behind the confident candidates. */
  board?: PostingCandidateView[];
  needsCareersUrl?: boolean;
  /** The one candidate came from a message's link, on a board the company does not own. */
  needsConfirmation?: boolean;
  hint?: string;
  /** A large Workday board was read only in part (FR-D10's lookup cap). */
  note?: string;
}

export type AttachPostingVars = { posting: NormalizedPosting } | { url: string } | { text: string };

/**
 * Looks the opportunity's posting up: a job id in a linked message first, then the company's
 * ATS board. A single confident match is attached by the server, which answers 'attached'.
 */
export function useFindPosting(id: string) {
  const qc = useQueryClient();
  const refresh = useRefresh(id);
  return useMutation({
    mutationFn: () =>
      api<FindPostingResult>(`/opportunities/${enc(id)}/find-posting`, { method: 'POST' }),
    onSuccess: (res) => {
      if (res.opportunity !== undefined) qc.setQueryData(qk.opportunity(id), res.opportunity);
    },
    onSettled: refresh,
  });
}

/** Attaches a chosen candidate, a pasted link or pasted description text. */
export function useAttachPosting(id: string) {
  const qc = useQueryClient();
  const refresh = useRefresh(id);
  return useMutation({
    mutationFn: (body: AttachPostingVars) =>
      api<OpportunityView>(`/opportunities/${enc(id)}/posting`, { method: 'POST', body }),
    onSuccess: (opp) => qc.setQueryData(qk.opportunity(id), opp),
    onSettled: refresh,
  });
}

/** Asserts a flagged posting is right without the board ever settling it (issue #250). */
export function useConfirmPosting(id: string) {
  const qc = useQueryClient();
  const refresh = useRefresh(id);
  return useMutation({
    mutationFn: () =>
      api<OpportunityView>(`/opportunities/${enc(id)}/posting/confirm`, { method: 'POST' }),
    onSuccess: (opp) => qc.setQueryData(qk.opportunity(id), opp),
    onSettled: refresh,
  });
}

/** Reverses a mistaken confirm (issue #250), back to needs_review. */
export function useUnconfirmPosting(id: string) {
  const qc = useQueryClient();
  const refresh = useRefresh(id);
  return useMutation({
    mutationFn: () =>
      api<OpportunityView>(`/opportunities/${enc(id)}/posting/unconfirm`, { method: 'POST' }),
    onSuccess: (opp) => qc.setQueryData(qk.opportunity(id), opp),
    onSettled: refresh,
  });
}

/** What POST /opportunities/:id/posting/rederive answers; see routes/opportunityPosting.ts. */
export interface RederiveResult {
  outcome: 'merged' | 'capture_only' | 'no_description_found';
  /** Present unless the outcome is 'no_description_found', which changes nothing. */
  opportunity?: OpportunityView;
}

/**
 * Re-derives a description from the capture already on this opportunity's timeline (issue
 * #264): a board match merges in as usual when one is found, and the capture alone is used
 * otherwise. `force` bypasses the server's refusal to replace a user-written description or a
 * posting the user confirmed themselves (#250).
 */
export function useRederivePosting(id: string) {
  const qc = useQueryClient();
  const refresh = useRefresh(id);
  return useMutation({
    mutationFn: (force: boolean) =>
      api<RederiveResult>(`/opportunities/${enc(id)}/posting/rederive`, {
        method: 'POST',
        body: { force },
      }),
    onSuccess: (res) => {
      if (res.opportunity !== undefined) qc.setQueryData(qk.opportunity(id), res.opportunity);
    },
    onSettled: refresh,
  });
}
