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

/** What a confirmation rests on: a matched email, a captured page, or the user's word. */
export const SUBMISSION_CONFIRMATION_KINDS = ['email', 'page', 'user'] as const;
export type SubmissionConfirmationKind = (typeof SUBMISSION_CONFIRMATION_KINDS)[number];

export const SUBMISSION_FAILURE_REASONS = [
  'snapshot_failed',
  'prefill_unsupported',
  'destination_mismatch',
  'review_expired',
  'cancelled_by_user',
  'other',
] as const;
export type SubmissionFailureReason = (typeof SUBMISSION_FAILURE_REASONS)[number];

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
  fields: SubmissionFieldsSchema,
  answers: SubmissionAnswersSchema,
  reviewExpiresAt: TimestampSchema.nullable(),
  reviewedAt: TimestampSchema.nullable(),
  handedOffAt: TimestampSchema.nullable(),
  submittedAt: TimestampSchema.nullable(),
  confirmedAt: TimestampSchema.nullable(),
  confirmationKind: z.enum(SUBMISSION_CONFIRMATION_KINDS).nullable(),
  failureReason: z.enum(SUBMISSION_FAILURE_REASONS).nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Submission = z.infer<typeof SubmissionSchema>;
