import type { SubmissionStatus } from './schemas';

/**
 * Application submission lifecycle (assisted apply design, Part A section 4.3,
 * https://github.com/bgoleno/opportun/issues/79), modelled on stateMachine.ts so the server,
 * the tests and the UI share one table:
 *
 * - draft: the user prepares the attempt. Editing it is the one self-transition; it can be
 *   reviewed, or cancelled (abandoned).
 * - reviewed: the user confirmed the review screen. Any edit sends it back to draft; it can be
 *   handed off, or abandoned (cancelled, or the review expired).
 * - handed_off: the user opened the employer's form. Only the user can say it was submitted;
 *   it can also fail (a non-submission problem) or be abandoned (cancelled, or idle).
 * - submitted: the user says they submitted it. Evidence confirms it, the user reports the
 *   ATS refused the form (rejected), or the follow-up window passes with nothing (unknown).
 * - confirmed: evidence arrived. Unlinking a wrongly matched confirmation returns it to
 *   submitted (the milestone split's M2b criterion 5).
 * - unknown: no evidence yet; late evidence or the user's report settles it.
 * - rejected, failed, abandoned: terminal. A new attempt is a new row.
 *
 * "rejected" is the ATS refusing the form, never an employer turning the candidate down: that
 * stays in the opportunity's own lifecycle (stateMachine.ts, closed with a reason).
 *
 * Opportun never transmits an application, so no transition here is caused by Opportun
 * contacting an employer.
 */
const NEXT: ReadonlyMap<SubmissionStatus, readonly SubmissionStatus[]> = new Map<
  SubmissionStatus,
  readonly SubmissionStatus[]
>([
  ['draft', ['draft', 'reviewed', 'abandoned']],
  ['reviewed', ['draft', 'handed_off', 'abandoned']],
  ['handed_off', ['submitted', 'failed', 'abandoned']],
  ['submitted', ['confirmed', 'rejected', 'unknown']],
  ['confirmed', ['submitted']],
  ['unknown', ['confirmed', 'rejected']],
  ['rejected', []],
  ['failed', []],
  ['abandoned', []],
]);

/** A submission in one of these is the opportunity's live attempt: at most one at a time. */
export const LIVE_SUBMISSION_STATUSES = ['draft', 'reviewed', 'handed_off'] as const;

/** Nothing leaves these; the user starts a new attempt instead. */
export const TERMINAL_SUBMISSION_STATUSES = ['rejected', 'failed', 'abandoned'] as const;

export function isLiveSubmission(status: SubmissionStatus): boolean {
  return (LIVE_SUBMISSION_STATUSES as readonly SubmissionStatus[]).includes(status);
}

export class InvalidSubmissionTransitionError extends Error {
  readonly from: SubmissionStatus;
  readonly to: SubmissionStatus;

  constructor(from: SubmissionStatus, to: SubmissionStatus) {
    super(`Invalid submission transition ${from} -> ${to}`);
    this.name = 'InvalidSubmissionTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function canSubmissionTransition(from: SubmissionStatus, to: SubmissionStatus): boolean {
  return NEXT.get(from)?.includes(to) ?? false;
}

/** The status after the transition, or throws InvalidSubmissionTransitionError. */
export function applySubmissionTransition(
  current: { status: SubmissionStatus },
  to: SubmissionStatus,
): SubmissionStatus {
  if (!canSubmissionTransition(current.status, to)) {
    throw new InvalidSubmissionTransitionError(current.status, to);
  }
  return to;
}
