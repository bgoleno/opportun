// Queries and mutations for Assisted apply (assisted apply M1d,
// https://github.com/bgoleno/opportun/issues/117; design Part B). Everything here acts on one
// opportunity, or one submission, at a time: there is no list across opportunities (NG-3).
//
// Opportun never transmits an application. These calls create and edit a record, review it, and
// hand off: the server returns the employer's address for the browser to open, and never
// contacts it.
import type { Submission, SubmissionAnswer, SubmissionFields } from '@opportun/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, errorMessage } from '@/lib/api';
import { qk, type Page } from '@/lib/opportunities';
import { rk } from '@/components/resume/api';

const enc = encodeURIComponent;

/** How often a pending saved copy is checked. */
export const SNAPSHOT_POLL_MS = 3000;

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

/**
 * The profile values a form usually asks for, in the order the details step shows them. Keys
 * follow the server's field-name rule. firstName, lastName, linkedinUrl and websiteUrl are what
 * prefill fills by name (M3a, #181); the full name and the free-text links stay as they were,
 * and nothing is ever split or derived from them.
 */
export const DETAIL_FIELDS = [
  { key: 'firstName', label: 'First name', type: 'text', autoComplete: 'given-name' },
  { key: 'lastName', label: 'Last name', type: 'text', autoComplete: 'family-name' },
  { key: 'fullName', label: 'Full name', type: 'text', autoComplete: 'name' },
  { key: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
  { key: 'phone', label: 'Phone', type: 'tel', autoComplete: 'tel' },
  { key: 'location', label: 'Location', type: 'text', autoComplete: 'address-level2' },
  { key: 'workAuthorization', label: 'Work authorisation', type: 'text', autoComplete: 'off' },
  // 'off', not 'url': the browser's one "url" value is a home page, which belongs in Website.
  { key: 'linkedinUrl', label: 'LinkedIn profile', type: 'url', autoComplete: 'off' },
  { key: 'websiteUrl', label: 'Website', type: 'url', autoComplete: 'url' },
  { key: 'links', label: 'Links', type: 'text', autoComplete: 'url' },
] as const;

/** A field's label, or its key when the screens do not know it. */
export const detailLabel = (key: string): string =>
  DETAIL_FIELDS.find((f) => f.key === key)?.label ?? key;

/**
 * An attempt's fields as label and value rows, in the details step's order, then any other key
 * as stored. Stored order is not display order: Postgres jsonb sorts an object's keys.
 */
export function detailRows(
  fields: SubmissionFields,
): { key: string; label: string; value: string }[] {
  const values = new Map(Object.entries(fields));
  const known: string[] = DETAIL_FIELDS.map((f) => f.key);
  const keys = [
    ...known.filter((k) => values.has(k)),
    ...[...values.keys()].filter((k) => !known.includes(k)),
  ];
  return keys.map((key) => ({ key, label: detailLabel(key), value: values.get(key) ?? '' }));
}

/**
 * A refusal from the submission routes, in words. The server's error envelope carries the code
 * only (plugins/security.ts), so an ApiError's message is the code itself: never show it.
 */
export function submissionErrorText(err: unknown): string {
  const code = err instanceof ApiError ? err.code : null;
  switch (code) {
    case 'live_submission_exists':
      return 'This opportunity already has an application in progress, perhaps from another tab. It is shown now.';
    case 'invalid_transition':
    case 'conflict':
      return 'This application changed in another tab or window. The page now shows where it stands.';
    case 'resume_not_final':
      return 'Choose a finished resume: one marked Final.';
    case 'resume_not_found':
      return 'That resume is no longer available. Choose another.';
    case 'no_ats_identity':
      return "This opportunity is not linked to a posting on the company's own job board yet.";
    case 'posting_not_confirmed':
      return "This opportunity's posting needs review. Confirm it on the Details tab first.";
    case 'stage_not_eligible':
      return 'Applying is available at Interested, Preparing or Applied.';
    case 'destination_not_allowed':
      // At creation (#135): the opportunity's posting address is not the employer's own posting
      // on a recognised application site, so the handoff could never open it.
      return "This opportunity's posting address isn't the employer's own posting on a recognised application site, so Opportun can't open it for you. Apply from the posting directly.";
    case 'destination_not_https':
      return "The posting's address is not a secure (https) address, so it cannot be opened from here.";
    case 'idempotency_key_reused':
      return 'Something went wrong starting this application. Reload the page and try again.';
    case 'reapply_reason_required':
      return 'You already applied for this job, or have an application to it on the way. Say why you are applying again.';
    case 'submitted_at_before_handoff':
      return 'That is before you opened the form. Choose when you pressed Submit.';
    case 'submitted_at_in_future':
      return 'That time has not happened yet. Choose when you pressed Submit.';
    // The fields prefill fills by name (#181): the server names the field, never its value.
    case 'field_url_invalid':
      return `${refusedField(err)}: enter the whole web address, starting with https:// (or http://).`;
    case 'field_name_invalid':
      return `${refusedField(err)}: use one line of plain text, up to 100 characters, with no spaces at the start or end.`;
    // #203, tl's wording.
    case 'field_email_invalid':
      return `${refusedField(err)}: an email address must be one line, like name@example.com.`;
    case 'field_phone_invalid':
      return `${refusedField(err)}: a phone number may hold digits, spaces, +, -, ., ( ) and an extension.`;
    case null:
      return 'Could not reach Opportun. Check your connection and try again.';
    default:
      // The shared wording (validation, rate_limited, csrf, ...), never a bare code.
      return errorMessage(err);
  }
}

/** The label of the field a 422 names, or a plain stand-in when it names none we know. */
function refusedField(err: unknown): string {
  const field = err instanceof ApiError ? err.details.field : undefined;
  return typeof field === 'string' ? detailLabel(field) : 'One of your details';
}

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
  /** The caller's own daily review usage and cap (#130). */
  reviewUsage: ['submissions', 'review-usage'] as const,
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
    // A saved copy being prepared (#115) usually takes seconds: read again until it settles, so
    // the review's confirm turns on by itself. Nothing polls otherwise.
    refetchInterval: (q) =>
      q.state.data?.items.some((s) => s.snapshotState === 'pending') === true
        ? SNAPSHOT_POLL_MS
        : false,
  });
}

function useInvalidate(opportunityId: string) {
  const qc = useQueryClient();
  // An attempt changed: its list, and the daily review usage a review may have moved (#130).
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ak.submissions(opportunityId) }),
      qc.invalidateQueries({ queryKey: ak.reviewUsage }),
      // A submission detail page open on it reads it again too (#149).
      qc.invalidateQueries({ queryKey: ['submissions', 'one'] }),
    ]);
}

/** One attempt (GET /submissions/:id, #149), or why there is none to show. */
export type SubmissionLoad =
  { kind: 'ok'; submission: SubmissionView } | { kind: 'off' } | { kind: 'not_found' };

/**
 * One attempt, for the submission detail page. A 404 is either the feature being off (or the
 * demo: `feature_unavailable`) or no such attempt for this user (another user's reads the same).
 */
export function useSubmission(id: string) {
  return useQuery({
    queryKey: ['submissions', 'one', id] as const,
    queryFn: async (): Promise<SubmissionLoad> => {
      try {
        return { kind: 'ok', submission: await api<SubmissionView>(`/submissions/${enc(id)}`) };
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          return err.code === 'feature_unavailable' ? { kind: 'off' } : { kind: 'not_found' };
        }
        throw err;
      }
    },
    retry: false,
  });
}

export function useCreateSubmission(opportunityId: string) {
  const invalidate = useInvalidate(opportunityId);
  return useMutation({
    mutationFn: (body: { idempotencyKey: string; resumeId: string }) =>
      api<SubmissionView>(`/opportunities/${enc(opportunityId)}/submissions`, {
        method: 'POST',
        body,
      }),
    // Settled: a refused create (another tab started one: live_submission_exists) must show
    // the attempt that exists, not leave the page retrying the same refusal.
    onSettled: invalidate,
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
    onSettled: invalidate,
  });
}

export function useReviewSubmission(opportunityId: string) {
  const invalidate = useInvalidate(opportunityId);
  return useMutation({
    mutationFn: ({
      id,
      reviewDigest,
      reapplyReason,
    }: {
      id: string;
      reviewDigest: string;
      /** Why the user applies again to a requisition they already applied to (M2a, #118). */
      reapplyReason?: string;
    }) =>
      api<SubmissionView>(`/submissions/${enc(id)}/review`, {
        method: 'POST',
        body: {
          reviewDigest,
          acknowledged: true,
          ...(reapplyReason === undefined ? {} : { reapplyReason }),
        },
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

/**
 * "I submitted it" (M2a, #118): the user's word, recorded once. `moveToApplied` is the tick the
 * user left (pre-ticked, owner decision 3); `submittedAt` only when they changed the time.
 */
export function useAttestSubmission(opportunityId: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidate(opportunityId);
  return useMutation({
    mutationFn: ({
      id,
      moveToApplied,
      submittedAt,
    }: {
      id: string;
      moveToApplied: boolean;
      submittedAt?: number;
    }) =>
      api<SubmissionView>(`/submissions/${enc(id)}/attest`, {
        method: 'POST',
        body: { moveToApplied, ...(submittedAt === undefined ? {} : { submittedAt }) },
      }),
    onSettled: async () => {
      await invalidate();
      // The stage, the timeline and the resume record changed: the pages that show them read
      // again (qk.opportunity covers its timeline and next steps).
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.opportunity(opportunityId) }),
        qc.invalidateQueries({ queryKey: qk.opportunities }),
        qc.invalidateQueries({ queryKey: qk.dashboard }),
        // The resume record is now a send (#158): every resume view, the Resume tab's list of
        // sends and the resume's derived status read again (tl on #164).
        qc.invalidateQueries({ queryKey: rk.resumes }),
      ]);
    },
  });
}

/** What the user reports after submitting (design S7; the server's SUBMISSION_OUTCOMES). */
export type ReportedOutcome = 'confirmed_by_user' | 'ats_refused';

/**
 * "I saw a confirmation" or "The site refused it" (#148). The server records it, adds the
 * timeline note, and closes the follow-up's next step if it is still open; the stage is left
 * alone.
 */
export function useRecordOutcome(opportunityId: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidate(opportunityId);
  return useMutation({
    mutationFn: ({ id, outcome, note }: { id: string; outcome: ReportedOutcome; note?: string }) =>
      api<SubmissionView>(`/submissions/${enc(id)}/outcome`, {
        method: 'POST',
        body: {
          outcome,
          ...(note === undefined || note.trim() === '' ? {} : { note: note.trim() }),
        },
      }),
    onSettled: async () => {
      await invalidate();
      // The timeline gains a note and the follow-up step closes (qk.opportunity covers both);
      // the dashboard lists open next steps.
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.opportunity(opportunityId) }),
        qc.invalidateQueries({ queryKey: qk.dashboard }),
      ]);
    },
  });
}

/**
 * "Not this application" (#119): undoes an email confirmation. The attempt returns to submitted,
 * and the email leaves the opportunity's timeline if the match put it there.
 */
export function useUnlinkConfirmation(opportunityId: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidate(opportunityId);
  return useMutation({
    mutationFn: (id: string) =>
      api<SubmissionView>(`/submissions/${enc(id)}/unlink-confirmation`, {
        method: 'POST',
        body: {},
      }),
    onSettled: async () => {
      await invalidate();
      // The timeline loses the email when the match had put it there.
      await qc.invalidateQueries({ queryKey: qk.opportunity(opportunityId) });
    },
  });
}

/**
 * Deletes the recorded confirmation page (#121) from the timeline. The application stays
 * confirmed: the user removed the page's text, not what it showed.
 */
export function useDeleteConfirmationPage(opportunityId: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidate(opportunityId);
  return useMutation({
    mutationFn: (activityId: string) =>
      api<void>(`/activities/${enc(activityId)}`, { method: 'DELETE' }),
    onSettled: async () => {
      await invalidate();
      await qc.invalidateQueries({ queryKey: qk.opportunity(opportunityId) });
    },
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

/** The caller's own daily review usage (GET /settings/applications, #130). */
export interface ReviewUsage {
  used: number;
  cap: number;
  instanceCap: number;
  userCap: number | null;
  /** When a place next frees up, or null when nothing is in the window. */
  nextFreeAt: number | null;
}

/**
 * The caller's daily review usage, or `null` where the feature does not exist (404, the flag off
 * or the demo): then neither the usage line nor the Settings control shows (#130 criterion 4).
 */
/**
 * The posting hosts the browser extension fills (its prefill.ts, greenhouseJobOf): only a form
 * on one of these can be filled from the review, whatever the application system says.
 */
const EXTENSION_FILLS_HOSTS = new Set(['boards.greenhouse.io', 'job-boards.greenhouse.io']);

/** A device token as the token list gives it (Settings > Integrations > Extensions and Connectors). */
interface DeviceTokenView {
  scopes: string[];
  revokedAt: number | null;
}

/**
 * Whether the browser extension can fill this application's form, so the review and Open steps
 * may tell the user to click it (#416, tl's note on #403): the application system is one the
 * extension fills (Greenhouse, on its own hosts), and the user has a token, not revoked, with
 * the Assisted apply scope. It reads the token list Settings reads, under the same key. Anything
 * else, a token list the server will not give included, is false: nothing is promised that the
 * user's setup cannot do.
 */
export function useExtensionCanFill(live: SubmissionView): boolean {
  const tokens = useQuery({
    queryKey: ['device-tokens'] as const,
    queryFn: () => api<{ items: DeviceTokenView[] }>('/device-tokens'),
    retry: false,
  });
  if (live.atsKind !== 'ats_greenhouse') return false;
  let host: string;
  try {
    host = new URL(live.destinationUrl).hostname;
  } catch {
    return false;
  }
  if (!EXTENSION_FILLS_HOSTS.has(host)) return false;
  return (tokens.data?.items ?? []).some(
    (t) => t.revokedAt === null && t.scopes.includes('apply:assist'),
  );
}

export function useReviewUsage() {
  return useQuery({
    queryKey: ak.reviewUsage,
    queryFn: async (): Promise<ReviewUsage | null> => {
      try {
        return await api<ReviewUsage>('/settings/applications');
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    retry: false,
  });
}

/** Sets the caller's own cap, 1 up to the instance's; null goes back to the instance's. */
export function useSetReviewCap() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cap: number | null) =>
      api<ReviewUsage>('/settings/applications', { method: 'PUT', body: { dailyReviewCap: cap } }),
    onSuccess: (usage) => qc.setQueryData(ak.reviewUsage, usage),
    onSettled: () => qc.invalidateQueries({ queryKey: ak.reviewUsage }),
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
