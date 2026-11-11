import { describe, expect, it } from 'vitest';
import { OPPORTUNITY_STAGES, type OpportunityStage } from './schemas';
import { InvalidTransitionError, applyTransition, canTransition } from './stateMachine';

// Expected allowed targets per source stage, written out by hand from design 4.7
// rather than derived, so the matrix test pins the rules independently.
const ALLOWED = new Map<OpportunityStage, readonly OpportunityStage[]>([
  [
    'discovered',
    ['interested', 'preparing', 'applied', 'in_process', 'offer', 'dismissed', 'closed'],
  ],
  [
    'interested',
    ['discovered', 'preparing', 'applied', 'in_process', 'offer', 'dismissed', 'closed'],
  ],
  [
    'preparing',
    ['discovered', 'interested', 'applied', 'in_process', 'offer', 'dismissed', 'closed'],
  ],
  [
    'applied',
    ['discovered', 'interested', 'preparing', 'in_process', 'offer', 'dismissed', 'closed'],
  ],
  [
    'in_process',
    ['discovered', 'interested', 'preparing', 'applied', 'offer', 'dismissed', 'closed'],
  ],
  [
    'offer',
    ['discovered', 'interested', 'preparing', 'applied', 'in_process', 'dismissed', 'closed'],
  ],
  [
    'dismissed',
    ['discovered', 'interested', 'preparing', 'applied', 'in_process', 'offer', 'closed'],
  ],
  [
    'closed',
    ['discovered', 'interested', 'preparing', 'applied', 'in_process', 'offer', 'dismissed'],
  ],
]);

const matrix = OPPORTUNITY_STAGES.flatMap((from) =>
  OPPORTUNITY_STAGES.map((to) => ({
    from,
    to,
    expected: ALLOWED.get(from)?.includes(to) ?? false,
  })),
);

describe('canTransition', () => {
  it('covers the full 8x8 matrix', () => {
    expect(matrix).toHaveLength(64);
  });

  it.each(matrix)('$from -> $to is $expected', ({ from, to, expected }) => {
    expect(canTransition(from, to)).toBe(expected);
  });
});

describe('applyTransition', () => {
  it('advances one step forward and records history', () => {
    const before = Date.now();
    const result = applyTransition({ stage: 'applied' }, 'in_process', { note: 'recruiter call' });
    expect(result.stage).toBe('in_process');
    expect(result.closedReason).toBeNull();
    expect(result.dismissedReason).toBeNull();
    expect(result.historyEntry.fromStage).toBe('applied');
    expect(result.historyEntry.toStage).toBe('in_process');
    expect(result.historyEntry.note).toBe('recruiter call');
    expect(result.historyEntry.at).toBeGreaterThanOrEqual(before);
    expect(Number.isInteger(result.historyEntry.at)).toBe(true);
  });

  it('skips forward over intermediate stages', () => {
    const result = applyTransition({ stage: 'discovered' }, 'applied');
    expect(result.stage).toBe('applied');
    expect(result.historyEntry.fromStage).toBe('discovered');
    expect(result.historyEntry.toStage).toBe('applied');
  });

  // #397: a mis-click several stages forward is corrected in one move back.
  it('moves back over several stages in one move and records it like any other', () => {
    const result = applyTransition({ stage: 'in_process' }, 'preparing');
    expect(result.stage).toBe('preparing');
    expect(result.closedReason).toBeNull();
    expect(result.dismissedReason).toBeNull();
    expect(result.historyEntry).toMatchObject({
      fromStage: 'in_process',
      toStage: 'preparing',
      note: null,
    });
  });

  it('defaults note to null when none is given', () => {
    expect(applyTransition({ stage: 'discovered' }, 'interested').historyEntry.note).toBeNull();
  });

  it('throws InvalidTransitionError carrying from and to for an invalid move', () => {
    let caught: unknown;
    try {
      applyTransition({ stage: 'offer' }, 'offer');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidTransitionError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as InvalidTransitionError).from).toBe('offer');
    expect((caught as InvalidTransitionError).to).toBe('offer');
  });

  it('throws on self-transition', () => {
    expect(() => applyTransition({ stage: 'applied' }, 'applied')).toThrow(InvalidTransitionError);
  });

  it('throws when closing without a closedReason', () => {
    expect(() => applyTransition({ stage: 'offer' }, 'closed')).toThrow(InvalidTransitionError);
  });

  it('closes with a reason', () => {
    const result = applyTransition({ stage: 'offer' }, 'closed', { closedReason: 'accepted' });
    expect(result.stage).toBe('closed');
    expect(result.closedReason).toBe('accepted');
    expect(result.dismissedReason).toBeNull();
  });

  it('dismisses with an optional reason', () => {
    expect(applyTransition({ stage: 'discovered' }, 'dismissed').dismissedReason).toBeNull();
    const result = applyTransition({ stage: 'discovered' }, 'dismissed', {
      dismissedReason: 'seniority',
    });
    expect(result.stage).toBe('dismissed');
    expect(result.dismissedReason).toBe('seniority');
    expect(result.closedReason).toBeNull();
  });

  it('ignores reasons that do not belong to the target stage', () => {
    const result = applyTransition({ stage: 'discovered' }, 'interested', {
      closedReason: 'rejected',
      dismissedReason: 'other',
    });
    expect(result.closedReason).toBeNull();
    expect(result.dismissedReason).toBeNull();
  });

  it('reopens from dismissed to interested and prefixes the note', () => {
    const result = applyTransition({ stage: 'dismissed' }, 'interested', {
      note: 'they raised the band',
    });
    expect(result.stage).toBe('interested');
    expect(result.dismissedReason).toBeNull();
    expect(result.historyEntry.note).toBe('reopened: they raised the band');
  });

  it('reopens from closed with a bare "reopened" note when none is given', () => {
    const result = applyTransition({ stage: 'closed' }, 'in_process');
    expect(result.stage).toBe('in_process');
    expect(result.closedReason).toBeNull();
    expect(result.historyEntry.note).toBe('reopened');
  });
});
