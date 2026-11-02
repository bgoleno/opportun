import { describe, expect, it } from 'vitest';
import { SUBMISSION_STATUSES, type SubmissionStatus } from './schemas';
import {
  InvalidSubmissionTransitionError,
  LIVE_SUBMISSION_STATUSES,
  TERMINAL_SUBMISSION_STATUSES,
  applySubmissionTransition,
  canSubmissionTransition,
  isLiveSubmission,
} from './submissionStateMachine';

// Expected allowed targets per status, written out by hand from the assisted-apply design,
// Part A section 4.3 (https://github.com/bgoleno/opportun/issues/79), rather than derived, so
// the matrix pins the rules independently of the module. Two additions, both from the Tech
// Lead's milestone split on #79: a draft can be cancelled (the cancel route, "to abandoned from
// non-terminal", limited here to the live statuses), and confirmed returns to submitted when the
// user unlinks a matched confirmation (M2b criterion 5).
const ALLOWED = new Map<SubmissionStatus, readonly SubmissionStatus[]>([
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

const matrix = SUBMISSION_STATUSES.flatMap((from) =>
  SUBMISSION_STATUSES.map((to) => [from, to, ALLOWED.get(from)!.includes(to)] as const),
);

describe('submission state machine', () => {
  it('the expected table names every status, as a source and as a target', () => {
    expect([...ALLOWED.keys()].sort()).toEqual([...SUBMISSION_STATUSES].sort());
    for (const targets of ALLOWED.values()) {
      for (const t of targets) expect(SUBMISSION_STATUSES).toContain(t);
    }
  });

  it.each(matrix)('%s -> %s allowed: %s', (from, to, allowed) => {
    expect(canSubmissionTransition(from, to)).toBe(allowed);
    if (allowed) {
      expect(applySubmissionTransition({ status: from }, to)).toBe(to);
    } else {
      expect(() => applySubmissionTransition({ status: from }, to)).toThrow(
        InvalidSubmissionTransitionError,
      );
    }
  });

  it('a refused transition names both statuses', () => {
    let caught: unknown;
    try {
      applySubmissionTransition({ status: 'abandoned' }, 'draft');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidSubmissionTransitionError);
    expect(caught).toMatchObject({ from: 'abandoned', to: 'draft' });
    expect((caught as Error).message).toBe('Invalid submission transition abandoned -> draft');
  });

  it('rejected, failed and abandoned are terminal: nothing leaves them', () => {
    expect([...TERMINAL_SUBMISSION_STATUSES].sort()).toEqual(['abandoned', 'failed', 'rejected']);
    for (const from of TERMINAL_SUBMISSION_STATUSES) {
      for (const to of SUBMISSION_STATUSES) expect(canSubmissionTransition(from, to)).toBe(false);
    }
  });

  it('a draft edit is the only self-transition', () => {
    for (const s of SUBMISSION_STATUSES) {
      expect(canSubmissionTransition(s, s), s).toBe(s === 'draft');
    }
  });

  it('the live statuses are draft, reviewed and handed_off: one per opportunity at a time', () => {
    expect([...LIVE_SUBMISSION_STATUSES]).toEqual(['draft', 'reviewed', 'handed_off']);
    for (const s of SUBMISSION_STATUSES) {
      expect(isLiveSubmission(s), s).toBe(LIVE_SUBMISSION_STATUSES.includes(s as never));
    }
  });

  it('only the user can make an attempt submitted: it is reached from handed_off alone', () => {
    // submitted is the user's attestation (design 4.3). No status but handed_off leads to it,
    // except an unlinked confirmation returning to it.
    const into = SUBMISSION_STATUSES.filter((s) => canSubmissionTransition(s, 'submitted'));
    expect(into.sort()).toEqual(['confirmed', 'handed_off']);
  });

  it('a new attempt is a new row: nothing returns to draft except from reviewed or draft', () => {
    const into = SUBMISSION_STATUSES.filter((s) => canSubmissionTransition(s, 'draft'));
    expect(into.sort()).toEqual(['draft', 'reviewed']);
  });
});
