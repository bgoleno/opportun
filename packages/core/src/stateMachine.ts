import type { ClosedReason, DismissReason, OpportunityStage } from './schemas';

/**
 * Opportunity lifecycle rules (design 4.7):
 * - forward along the chain to any later stage (skips allowed): discovered, interested,
 *   preparing, applied, in_process, offer (then closed)
 * - backward within the chain, one step only (in_process -> applied, not offer -> interested)
 * - any stage -> dismissed (optional reason); any stage -> closed (reason required)
 * - dismissed/closed -> any chain stage reopens, recorded with a "reopened" note
 * - self-transitions are invalid
 */
const CHAIN: readonly OpportunityStage[] = [
  'discovered',
  'interested',
  'preparing',
  'applied',
  'in_process',
  'offer',
];

function isTerminal(stage: OpportunityStage): boolean {
  return stage === 'dismissed' || stage === 'closed';
}

export class InvalidTransitionError extends Error {
  readonly from: OpportunityStage;
  readonly to: OpportunityStage;

  constructor(from: OpportunityStage, to: OpportunityStage, reason?: string) {
    super(`Invalid stage transition ${from} -> ${to}${reason ? `: ${reason}` : ''}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: OpportunityStage, to: OpportunityStage): boolean {
  if (from === to) return false;
  if (isTerminal(to)) return true;
  if (isTerminal(from)) return true;
  const delta = CHAIN.indexOf(to) - CHAIN.indexOf(from);
  return delta > 0 || delta === -1;
}

export interface TransitionOptions {
  closedReason?: ClosedReason;
  dismissedReason?: DismissReason;
  note?: string;
}

export interface TransitionResult {
  stage: OpportunityStage;
  closedReason: ClosedReason | null;
  dismissedReason: DismissReason | null;
  historyEntry: {
    fromStage: OpportunityStage;
    toStage: OpportunityStage;
    note: string | null;
    at: number;
  };
}

export function applyTransition(
  current: { stage: OpportunityStage },
  to: OpportunityStage,
  opts: TransitionOptions = {},
): TransitionResult {
  const from = current.stage;
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
  if (to === 'closed' && !opts.closedReason) {
    throw new InvalidTransitionError(from, to, 'closedReason is required');
  }

  let note = opts.note ?? null;
  if (isTerminal(from) && !isTerminal(to)) {
    note = note ? `reopened: ${note}` : 'reopened';
  }

  return {
    stage: to,
    closedReason: to === 'closed' ? (opts.closedReason ?? null) : null,
    dismissedReason: to === 'dismissed' ? (opts.dismissedReason ?? null) : null,
    historyEntry: { fromStage: from, toStage: to, note, at: Date.now() },
  };
}
