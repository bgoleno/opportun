// Application submissions: one attempt to apply to one opportunity (assisted apply,
// https://github.com/bgoleno/opportun/issues/79; data model in its design, Part A section 4).
// Opportun never transmits an application: a submission records what the user prepared,
// reviewed and, later, says they submitted themselves.
import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';
import { ATS_REF_KINDS } from './opportunity';
import { RESUME_STORES } from './resume';

/** Design 4.3. See submissionStateMachine.ts for which status may follow which. */
export const SUBMISSION_STATUSES = [
  'draft',
  'reviewed',
  'handed_off',
  'submitted',
  'confirmed',
  'rejected',
  'failed',
  'unknown',
  'abandoned',
] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

/** The signals a confirmation email can match on (lib/submissionMatch, #119). */
export const SUBMISSION_CONFIRMATION_SIGNALS = [
  'ats_job_ref',
  'sender_domain',
  'role_and_company',
  'time_window',
] as const;
export type SubmissionConfirmationSignal = (typeof SUBMISSION_CONFIRMATION_SIGNALS)[number];

/** What a confirmation rests on: a matched email, a captured page, or the user's word. */
export const SUBMISSION_CONFIRMATION_KINDS = ['email', 'page', 'user'] as const;
export type SubmissionConfirmationKind = (typeof SUBMISSION_CONFIRMATION_KINDS)[number];

export const SUBMISSION_FAILURE_REASONS = [
  'snapshot_failed',
  'prefill_unsupported',
  'destination_mismatch',
  'review_expired',
  'cancelled_by_user',
  'handoff_idle',
  'other',
] as const;
export type SubmissionFailureReason = (typeof SUBMISSION_FAILURE_REASONS)[number];

/**
 * The resume snapshot of a live attempt (https://github.com/bgoleno/opportun/issues/115):
 * `pending` while it is exported, `ready` when the file is stored, `unsupported` when the
 * resume's store has no PDF to give (the user attaches a file themselves; text is never
 * substituted), `failed` when the export failed and the user must act (share the document
 * again, reconnect Google, or choose the resume again to retry). Separate from `status`: a
 * failed export is not a failed application, so the draft and its answers stay.
 */
export const SUBMISSION_SNAPSHOT_STATES = ['pending', 'ready', 'unsupported', 'failed'] as const;
export type SubmissionSnapshotState = (typeof SUBMISSION_SNAPSHOT_STATES)[number];

/**
 * Why there is no snapshot: `export_unsupported`, or the resume store's export failure code
 * (DocumentExportFailure in apps/server/src/adapters/documentStore.ts), so the UI can say what
 * to do. The server's type must stay assignable to this list.
 */
export const SUBMISSION_SNAPSHOT_ERRORS = [
  'export_unsupported',
  'unavailable',
  'rate_limited',
  'not_found',
  'no_access',
  'reauth_required',
  'too_large',
  'not_pdf',
  'rejected',
] as const;
export type SubmissionSnapshotError = (typeof SUBMISSION_SNAPSHOT_ERRORS)[number];

/** Who wrote an answer: the user, or an AI draft the user accepted. */
export const SUBMISSION_ANSWER_SOURCES = ['user', 'ai_draft_accepted'] as const;
export type SubmissionAnswerSource = (typeof SUBMISSION_ANSWER_SOURCES)[number];

/** Field names are short identifiers (`email`, `phone`, `linkedinUrl`), never free text. */
const FIELD_KEY = /^[a-z][A-Za-z0-9_]{0,63}$/;

/**
 * The profile values the user approved for this form, by field name. Bounded so a request
 * cannot store an unbounded blob.
 */
export const SubmissionFieldsSchema = z
  .record(z.string().regex(FIELD_KEY), z.string().max(2_000))
  .refine((r) => Object.keys(r).length <= 50, { message: 'at most 50 fields' });
export type SubmissionFields = z.infer<typeof SubmissionFieldsSchema>;

/**
 * The detail fields prefill reads by name (M3a, https://github.com/bgoleno/opportun/issues/181;
 * tl's design on #120): it fills a form's first and last name, and its LinkedIn and website
 * questions, with exactly these values, so the extension never splits a full name or a
 * free-text links field. Every other key stays free text, as before.
 */
export const SUBMISSION_NAME_FIELDS = ['firstName', 'lastName'] as const;
export const SUBMISSION_URL_FIELDS = ['linkedinUrl', 'websiteUrl'] as const;
/** Counted in characters as a person counts them (code points), not UTF-16 units. */
export const SUBMISSION_NAME_MAX_LENGTH = 100;

export const SUBMISSION_FIELD_REFUSALS = ['field_name_invalid', 'field_url_invalid'] as const;
export type SubmissionFieldRefusal = (typeof SUBMISSION_FIELD_REFUSALS)[number];

/** Control characters, and the line and paragraph separators that also break a line. */
const NOT_ONE_LINE = /[\p{Cc}\u2028\u2029]/u;

function isPlainName(value: string): boolean {
  const length = [...value].length;
  return (
    value === value.trim() &&
    length >= 1 &&
    length <= SUBMISSION_NAME_MAX_LENGTH &&
    !NOT_ONE_LINE.test(value)
  );
}

/**
 * An absolute http or https address with a host, exactly as typed: no surrounding or inner
 * whitespace, which the URL parser would otherwise trim or encode into something the user
 * never saw on the review.
 */
function isWebAddress(value: string): boolean {
  if (/\s/u.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname !== '';
}

/**
 * The first named field whose value breaks its rule, in a fixed order (names, then links), or
 * null. The server refuses the edit with the code as a 422 and the field's name, never its value.
 */
export function submissionFieldProblem(
  fields: Record<string, string>,
): { field: string; code: SubmissionFieldRefusal } | null {
  for (const field of SUBMISSION_NAME_FIELDS) {
    const value = fields[field];
    if (value !== undefined && !isPlainName(value)) return { field, code: 'field_name_invalid' };
  }
  for (const field of SUBMISSION_URL_FIELDS) {
    const value = fields[field];
    if (value !== undefined && !isWebAddress(value)) return { field, code: 'field_url_invalid' };
  }
  return null;
}

/** One application question and the user's answer to it. User-authored, treated like notes. */
export const SubmissionAnswerSchema = z
  .object({
    questionKey: z.string().trim().min(1).max(200),
    label: z.string().trim().min(1).max(1_000),
    value: z.string().max(10_000),
    source: z.enum(SUBMISSION_ANSWER_SOURCES),
  })
  .strict();
export type SubmissionAnswer = z.infer<typeof SubmissionAnswerSchema>;

export const SubmissionAnswersSchema = z.array(SubmissionAnswerSchema).max(100);

/** A submission as the API returns it. */
export const SubmissionSchema = z.object({
  id: IdSchema,
  opportunityId: IdSchema,
  resumeId: IdSchema.nullable(),
  atsKind: z.enum(ATS_REF_KINDS),
  atsRef: z.string().nullable(),
  atsExternalId: z.string(),
  destinationUrl: z.string(),
  status: z.enum(SUBMISSION_STATUSES),
  idempotencyKey: z.string(),
  resumeSha256: z.string().nullable(),
  resumeTitle: z.string().nullable(),
  resumeStore: z.enum(RESUME_STORES).nullable(),
  snapshotState: z.enum(SUBMISSION_SNAPSHOT_STATES),
  /**
   * The snapshot's attachments row (on the opportunity, GET /opportunities/:id/attachments has
   * its filename, size and mime), or null when there is none or it was deleted.
   */
  resumeAttachmentId: IdSchema.nullable(),
  snapshotError: z.enum(SUBMISSION_SNAPSHOT_ERRORS).nullable(),
  fields: SubmissionFieldsSchema,
  answers: SubmissionAnswersSchema,
  /**
   * The digest of the attempt as it stands now (design Part A 4.5). The review screen sends it
   * back with POST /submissions/:id/review, proving it showed the state the server holds.
   */
  reviewDigest: z.string(),
  /** Until when a review may be handed off: a fixed time, never a countdown (owner's decision). */
  reviewExpiresAt: TimestampSchema.nullable(),
  reviewedAt: TimestampSchema.nullable(),
  handedOffAt: TimestampSchema.nullable(),
  submittedAt: TimestampSchema.nullable(),
  confirmedAt: TimestampSchema.nullable(),
  confirmationKind: z.enum(SUBMISSION_CONFIRMATION_KINDS).nullable(),
  /**
   * The matched confirmation email (#119), on GET /submissions/:id only, and only while an email
   * is the confirmation. What the evidence card shows, never the body (NFR-PRV5): the subject,
   * the sender's address (its display name is the sender's own claim, so it is left out), when
   * it was sent, and the names of the signals that matched.
   */
  confirmationEmail: z
    .object({
      communicationId: IdSchema,
      subject: z.string().nullable(),
      fromAddress: z.string(),
      sentAt: TimestampSchema,
      signals: z.array(z.enum(SUBMISSION_CONFIRMATION_SIGNALS)),
    })
    .nullable()
    .optional(),
  failureReason: z.enum(SUBMISSION_FAILURE_REASONS).nullable(),
  /**
   * A re-application (owner decision 6, #118): the earlier attempt at the same requisition, and
   * the reason the user typed at review. Both null for a first application.
   */
  reapplyOf: IdSchema.nullable(),
  reapplyReason: z.string().nullable(),
  /**
   * When the opportunity's posting changed under this attempt (#144); the attempt still goes to
   * its pinned destination, and the screens say so. Null when it never did.
   */
  postingChangedAt: TimestampSchema.nullable(),
  /** The timeline entry the user's "I submitted it" created (M2a, #118). */
  submittedActivityId: IdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Submission = z.infer<typeof SubmissionSchema>;
