// Queries and mutations for one opportunity's detail page.
import type { Activity, ActivityKind, NextStep, NormalizedPosting } from '@opportun/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
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
    // While a background check reads the board, read the opportunity again every few seconds
    // (#852, qa on #865), so the page shows the check's result once it lands rather than a stale
    // 'searching' that invites a second search.
    refetchInterval: (q) => (q.state.data?.postingState === 'searching' ? 3000 : false),
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
  /** 'identified' (#398): the opportunity's own careers link got its Greenhouse identity. */
  /**
   * 'unreachable' (#835, #866): the company's boards could not be read, or the search for one
   * could not finish, which is not "no match" or "no board".
   * 'already_confirmed' (#852): a background check confirmed it after the page loaded.
   */
  outcome:
    | 'attached'
    | 'identified'
    | 'candidates'
    | 'none'
    | 'no_board'
    | 'unreachable'
    | 'already_confirmed';
  /** An attach that changed nothing: a Refetch that found the same job (#835). */
  unchanged?: true;
  /** What a Refetch changed (#866): absent on a first attach, and when `unchanged`. */
  changed?: ('link' | 'job' | 'description' | 'location' | 'remote' | 'compensation')[];
  /** The posting was confirmed, with the user's own description left as it was, not compared (#866). */
  keptDescription?: true;
  /** Present when the outcome is 'attached' or 'identified'. */
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
  /** What was searched for, opaque: sent back with a row picked from it (#892). */
  searchedFor?: string;
  /** A large Workday board was read only in part (FR-D10's lookup cap). */
  note?: string;
}

export type AttachPostingVars = (
  { posting: NormalizedPosting; searchedFor?: string } | { url: string } | { text: string }
) & {
  replaceDescription?: string;
};

/**
 * Looks the opportunity's posting up: a job id in a linked message first, then the company's
 * ATS board. A single confident match is attached by the server, which answers 'attached'.
 */
export function useFindPosting(id: string) {
  const qc = useQueryClient();
  const refresh = useRefresh(id);
  return useMutation({
    // `seen`: the posting state the page showed (#852): a posting a background check confirmed
    // since is answered as it is ('already_confirmed'), never searched again.
    // `replaceDescription`: the description the user agreed to lose (descriptionAtStake).
    mutationFn: (vars: { seen: string; replaceDescription?: string }) =>
      api<FindPostingResult>(
        `/opportunities/${enc(id)}/find-posting?${new URLSearchParams(vars).toString()}`,
        { method: 'POST' },
      ),
    onSuccess: (res) => {
      if (res.opportunity !== undefined) qc.setQueryData(qk.opportunity(id), res.opportunity);
    },
    onSettled: refresh,
  });
}

/** Find posting refused because a background check is reading the board (#852). */
export function isPostingSearching(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'posting_searching';
}

/**
 * A number that moves on when the posting leaves 'searching', or otherwise changes to a state
 * with no check under way (#870). Read when Find posting is pressed and again when its refusal
 * (isPostingSearching) is shown: a different number means the check it speaks of is over, so the
 * refusal no longer holds. Counted, not compared by state, because a check can end in the state
 * it found ('needs_review' again), and because the refusal's own refresh can bring the check's
 * end before the refusal itself arrives (useFindPosting waits for it).
 */
export function useChecksEnded(postingState: OpportunityView['postingState']): number {
  const state = postingState ?? null;
  const [last, setLast] = useState({ state, ended: 0 });
  if (last.state === state) return last.ended;
  const next = { state, ended: state === 'searching' ? last.ended : last.ended + 1 };
  setLast(next);
  return next.ended;
}

/**
 * Whether the check a Find posting refusal speaks of is over already (#866, tl and qa on #885):
 * called once the refusal is in, when the refresh after it has been read (useFindPosting waits for
 * it). The check can have ended in the state the page showed, which useChecksEnded cannot see.
 * Says no when that refresh failed, or nothing on the page reads the opportunity: not known.
 */
export function useCheckOver(id: string): () => boolean {
  const qc = useQueryClient();
  return () => {
    const read = qc.getQueryState<OpportunityView>(qk.opportunity(id));
    return (
      read?.data !== undefined &&
      read.status === 'success' &&
      !read.isInvalidated &&
      read.data.postingState !== 'searching'
    );
  };
}

/**
 * Said in place of a refusal for a check that is over: the click is answered (#866). "Ended", and
 * not as a success: its job may have died (#869), which the posting's own notice then says.
 */
export const CHECK_ENDED = {
  title: 'Check ended',
  description: 'The board check ended while this page was open. The page is up to date now.',
} as const;

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
  /** 'left_alone' (#851): the description changed while the board was read; nothing written. */
  outcome: 'merged' | 'capture_only' | 'no_description_found' | 'left_alone';
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
    // `replaceDescription`: the description the user was asked about (shownDescription, #1010).
    mutationFn: (vars: { force: boolean; replaceDescription: string }) =>
      api<RederiveResult>(`/opportunities/${enc(id)}/posting/rederive`, {
        method: 'POST',
        body: vars,
      }),
    onSuccess: (res) => {
      if (res.opportunity !== undefined) qc.setQueryData(qk.opportunity(id), res.opportunity);
    },
    onSettled: refresh,
  });
}
