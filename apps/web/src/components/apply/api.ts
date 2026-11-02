// Queries and mutations for Assisted apply (assisted apply M1d,
// https://github.com/bgoleno/opportun/issues/117; design Part B). Everything here acts on one
// opportunity, or one submission, at a time: there is no list across opportunities (NG-3).
//
// Opportun never transmits an application. These calls create and edit a record, review it, and
// hand off: the server returns the employer's address for the browser to open, and never
// contacts it.
import type { Submission, SubmissionAnswer, SubmissionFields } from '@opportun/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import type { Page } from '@/lib/opportunities';

const enc = encodeURIComponent;

/**
 * A submission as the API returns it. `reviewDigest` arrives with the review gate (M1c, #129)
 * and the snapshot fields with the resume snapshot (#115); until each lands it is absent, and
 * the screens say so rather than guess.
 */
export type SubmissionView = Submission & {
  reviewDigest?: string;
  snapshotState?: 'pending' | 'ready' | 'unsupported' | 'failed';
  /** A code (core's SUBMISSION_SNAPSHOT_ERRORS), worded by snapshotErrorText. */
  snapshotError?: string | null;
  /** The saved copy, an attachments row on the opportunity (#115). */
  resumeAttachmentId?: string | null;
};

/** What the user can do about a snapshot that could not be made, in words (#115's codes). */
export function snapshotErrorText(code: string | null | undefined): string {
  switch (code) {
    case 'export_unsupported':
      return 'This kind of resume cannot be saved as a PDF here. You will attach the file yourself on the application site.';
    case 'not_found':
      return 'The resume document is gone. Choose another resume.';
    case 'no_access':
      return 'Opportun can no longer open this document. Share it again, then try again.';
    case 'reauth_required':
      return 'Reconnect Google in Settings, then try again.';
    case 'too_large':
      return 'The PDF is larger than 10 MB. Attach the file yourself on the application site.';
    case 'unavailable':
    case 'rate_limited':
      return 'Google is busy right now. Try again in a few minutes.';
    default:
      return 'Choose the resume again, or attach the file yourself on the application site.';
  }
}

export const ak = {
  submissions: (opportunityId: string) => ['submissions', 'opportunity', opportunityId] as const,
  submission: (id: string) => ['submissions', id] as const,
};

/** The statuses of an attempt that is still in progress: at most one per opportunity. */
const LIVE: readonly string[] = ['draft', 'reviewed', 'handed_off'];
export const isLive = (s: Pick<Submission, 'status'>): boolean => LIVE.includes(s.status);

/**
 * The opportunity's attempts, or `null` when the feature does not exist here: with the flag off,
 * or on the demo, every submission route answers 404 feature_unavailable (design 7.8), and the
 * page shows nothing of the feature (#117 criterion 5). Any other failure also hides it: the
 * panel is never the reason an opportunity page breaks.
 */
export function useOpportunitySubmissions(opportunityId: string) {
  return useQuery({
    queryKey: ak.submissions(opportunityId),
    queryFn: async (): Promise<Page<SubmissionView> | null> => {
      try {
        return await api<Page<SubmissionView>>(
          `/opportunities/${enc(opportunityId)}/submissions?limit=20`,
        );
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    retry: false,
  });
}

function useInvalidate(opportunityId: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ak.submissions(opportunityId) });
}

export function useCreateSubmission(opportunityId: string) {
  const invalidate = useInvalidate(opportunityId);
  return useMutation({
    mutationFn: (body: { idempotencyKey: string; resumeId: string }) =>
      api<SubmissionView>(`/opportunities/${enc(opportunityId)}/submissions`, {
        method: 'POST',
        body,
      }),
    onSuccess: invalidate,
  });
}

export interface SubmissionPatch {
  resumeId?: string;
  fields?: SubmissionFields;
  answers?: SubmissionAnswer[];
}

/** An edit. After a review it sends the attempt back to draft (design 4.3). */
export function usePatchSubmission(opportunityId: string) {
  const invalidate = useInvalidate(opportunityId);
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: SubmissionPatch }) =>
      api<SubmissionView>(`/submissions/${enc(id)}`, { method: 'PATCH', body: patch }),
    onSuccess: invalidate,
  });
}

export function useReviewSubmission(opportunityId: string) {
  const invalidate = useInvalidate(opportunityId);
  return useMutation({
    mutationFn: ({ id, reviewDigest }: { id: string; reviewDigest: string }) =>
      api<SubmissionView>(`/submissions/${enc(id)}/review`, {
        method: 'POST',
        body: { reviewDigest, acknowledged: true },
      }),
    // Settled, not only on success: a refusal (stale, expired) must refresh the digest the
    // screen holds, or the next attempt would send the same stale one.
    onSettled: invalidate,
  });
}

export interface HandoffResult {
  destinationUrl: string;
  expiresAt: number;
}

export function useHandoffSubmission(opportunityId: string) {
  const invalidate = useInvalidate(opportunityId);
  return useMutation({
    mutationFn: (id: string) =>
      api<HandoffResult>(`/submissions/${enc(id)}/handoff`, { method: 'POST', body: {} }),
    onSettled: invalidate,
  });
}

export function useCancelSubmission(opportunityId: string) {
  const invalidate = useInvalidate(opportunityId);
  return useMutation({
    mutationFn: (id: string) =>
      api<SubmissionView>(`/submissions/${enc(id)}/cancel`, { method: 'POST' }),
    onSuccess: invalidate,
  });
}

/** The application system's own name, for "Apply on <ATS>" (owner's naming on #79). */
export function atsLabel(kind: string): string {
  switch (kind) {
    case 'ats_greenhouse':
      return 'Greenhouse';
    case 'ats_lever':
      return 'Lever';
    case 'ats_ashby':
      return 'Ashby';
    case 'ats_workday':
      return 'Workday';
    default:
      return 'the application site';
  }
}

/** The host of an address, for "open jobs.example.com"; the address itself when unparseable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/** A clock time ("14:42"): the review's "valid until" is a fixed time, never a countdown. */
export function clockTime(ms: number): string {
  return clock.format(ms);
}
