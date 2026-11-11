// The resume flow's state for one opportunity (https://github.com/bgoleno/opportun/issues/428,
// slice 1 of #400, tl's table A to H). One pure function, from what the Resume tab and the
// Assisted apply panel already load, so the two can never disagree about where the user is.
//
// The steps: 1 Base, 2 Tailor, 3 Finish, 4 Apply. "This opportunity's resume" is its newest
// tailored resume that is not archived.
import { appliedAttempt, isLive, type SubmissionView } from '@/components/apply/api';
import { statusLabel, type Resume, type ResumeSend } from './api';

export interface FlowInput {
  opportunityId: string;
  /** The user's resumes: bases and tailored copies, any opportunity's. */
  resumes: readonly Resume[];
  /** This opportunity's recorded sends. */
  sends: readonly ResumeSend[];
  /** This opportunity's assisted apply attempts, newest first. */
  attempts: readonly SubmissionView[];
  /** Why assisted apply cannot start for a reason other than the resume, or null. */
  applyBlocked: string | null;
  /**
   * 'unavailable' when assisted apply is not available here at all (the feature off, or the
   * demo): a value of its own, not an empty reason, so nothing of the feature is named (tl on
   * #440, ruling 2).
   */
  assistedApply?: 'unavailable';
}

export type ResumeFlowState =
  /** No base resume registered. */
  | { state: 'A'; step: 1 }
  /** A base exists; nothing for this opportunity yet. */
  | { state: 'B'; step: 1 }
  /** This opportunity's tailored copy is a Draft. */
  | { state: 'C'; step: 2; resume: Resume }
  /** It is In review. */
  | { state: 'D'; step: 3; resume: Resume }
  /** It is Final, and assisted apply can start. */
  | { state: 'E'; step: 4; resume: Resume }
  /** It is Final, but assisted apply cannot start, for `reason`. */
  | { state: 'F'; step: 4; resume: Resume; reason: string }
  /** It is Final, and assisted apply is not available here: it is sent by hand. */
  | { state: 'F'; step: 4; resume: Resume; unavailable: true }
  /** An assisted apply attempt is in progress. */
  | { state: 'G'; step: 4; attempt: SubmissionView }
  /**
   * Done: an application was made (the attempt #404's panel leads with), a send is recorded,
   * or the resume is Submitted. `again` is this opportunity's resume when it was made since and
   * has gone nowhere yet (tl on #440, ruling 6), so the flow names it rather than offering to
   * tailor again.
   */
  | {
      state: 'H';
      step: 'done';
      attempt?: SubmissionView;
      send?: ResumeSend;
      resume?: Resume;
      again?: Resume;
    };

/** This opportunity's resume: its newest tailored copy that is not archived. */
function currentResume(input: FlowInput): Resume | undefined {
  return input.resumes
    .filter(
      (r) =>
        r.kind === 'tailored' && r.opportunityId === input.opportunityId && r.archivedAt === null,
    )
    .reduce<Resume | undefined>(
      (newest, r) => (newest === undefined || r.createdAt > newest.createdAt ? r : newest),
      undefined,
    );
}

/**
 * H with this opportunity's resume as `again`, when it has gone nowhere yet: no send of it here,
 * no attempt made with it, and not Submitted (tl on #440, ruling 6).
 */
function withAgain(
  h: Extract<ResumeFlowState, { state: 'H' }>,
  resume: Resume | undefined,
  input: FlowInput,
): ResumeFlowState {
  if (resume === undefined || resume.status === 'submitted') return h;
  if (input.sends.some((s) => s.resumeId === resume.id)) return h;
  // An attempt that applied with it (one in progress is G, before H).
  if (input.attempts.some((a) => a.resumeId === resume.id && appliedAttempt([a]) !== undefined)) {
    return h;
  }
  return { ...h, again: resume };
}

/**
 * Where the user is in the resume flow. An attempt in progress comes first, then anything that
 * shows the user has applied (so state H is exactly #404's applied state when an attempt was
 * made), then this opportunity's resume by its status, then whether a base exists.
 */
export function resumeFlowState(input: FlowInput): ResumeFlowState {
  const live = input.attempts.find(isLive);
  if (live !== undefined) return { state: 'G', step: 4, attempt: live };
  const resume = currentResume(input);
  const applied = appliedAttempt(input.attempts);
  if (applied !== undefined) {
    return withAgain({ state: 'H', step: 'done', attempt: applied }, resume, input);
  }
  const [send] = input.sends;
  if (send !== undefined) return withAgain({ state: 'H', step: 'done', send }, resume, input);
  if (resume !== undefined) {
    if (resume.status === 'submitted') return { state: 'H', step: 'done', resume };
    if (resume.status === 'draft') return { state: 'C', step: 2, resume };
    if (resume.status === 'in_review') return { state: 'D', step: 3, resume };
    if (input.assistedApply === 'unavailable') {
      return { state: 'F', step: 4, resume, unavailable: true };
    }
    return input.applyBlocked === null
      ? { state: 'E', step: 4, resume }
      : { state: 'F', step: 4, resume, reason: input.applyBlocked };
  }
  const hasBase = input.resumes.some((r) => r.kind === 'base' && r.archivedAt === null);
  return hasBase ? { state: 'B', step: 1 } : { state: 'A', step: 1 };
}

/**
 * The flow's own sentence for the states where the resume is what stands in the way of applying
 * (A to D, and H through a send: tl on #428), as the Assisted apply panel says it; null for the
 * others.
 */
export function flowSentence(state: ResumeFlowState): string | null {
  switch (state.state) {
    case 'A':
      return 'Add a base resume to start.';
    case 'B':
      return 'Choose the resume to start from.';
    case 'C':
      return `"${state.resume.title}" is still a ${statusLabel(state.resume.status)}. Tailor it, then mark it as final to apply.`;
    case 'D':
      return `"${state.resume.title}" is still ${statusLabel(state.resume.status)}. Mark it as final to apply.`;
    case 'H':
      // A copy made since, not Final yet: its own words, as in C and D (tl on #440, ruling 6).
      if (state.again?.status === 'draft')
        return flowSentence({ state: 'C', step: 2, resume: state.again });
      if (state.again?.status === 'in_review')
        return flowSentence({ state: 'D', step: 3, resume: state.again });
      // Sent another way (a base sent as it is), and no resume assisted apply can use yet.
      return state.send !== undefined
        ? 'A resume is already recorded as sent for this opportunity. To apply here too, mark a resume as final.'
        : null;
    default:
      return null;
  }
}
