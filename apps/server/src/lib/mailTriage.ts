// Stage 1 of the mail funnel (spec D1): a local, deterministic verdict on one sender, with no
// model and no I/O, so it is cheap enough to run on every message and testable in isolation.
//
// This module implements the rules Plan 1 covers:
//
//   rule 0  user allow list     pass, and it beats everything below
//   rule 1  user deny list      drop
//   rule 2  consumer-domain veto  drop (built-in list, one per-user toggle)
//   rule 4  job sender          inert here; Plan 2 gives it its meaning
//
// triageMessage at the bottom of this file adds rules 3 to 7, which need the message text as
// well as the sender. triageSender stays as the sender-only entry point, because a caller
// that has not read the body yet should not get a verdict that pretends it has.
import {
  isConsumerAddress,
  matchesJobSenderSeed,
  matchesMailPattern,
  parseMailPattern,
} from '@opportun/core';
import { privateSenderSignal } from './privateContent';
import { jobVocabularySignal, privateContentSignal } from './textSignals';
import type { MailFilterRuleRow } from '../repos/mailFilters';

export interface RuleVerdict {
  decision: 'allow' | 'deny' | 'none';
  /** The rule that decided, so a filtered row can say why in concrete terms. */
  ruleId: string | null;
  pattern: string | null;
}

/**
 * How narrow a pattern is. An exact address beats `*@domain`, which beats `*@*.domain`, so a
 * user who denies a whole domain and allows one address in it gets what they obviously meant.
 */
function specificity(pattern: string): number {
  const parsed = parseMailPattern(pattern);
  if (parsed === null) return -1;
  if (parsed.subdomains) return 0;
  return parsed.local === '*' ? 1 : 2;
}

/** The user's own rules only (rules 0, 1 and the inert 4). Pure. */
export function evaluateRules(address: string, rules: MailFilterRuleRow[]): RuleVerdict {
  let best: { rule: MailFilterRuleRow; rank: number; specificity: number } | null = null;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    // job_sender is rule 4, below both vetoes, which Plan 1 does not implement. Honoring it
    // here would wrongly let it outrank rules it must lose to, so it is skipped entirely.
    if (rule.effect !== 'allow' && rule.effect !== 'deny') continue;
    const parsed = parseMailPattern(rule.pattern);
    if (parsed === null || !matchesMailPattern(address, parsed)) continue;
    const rank = rule.effect === 'allow' ? 0 : 1;
    const score = specificity(rule.pattern);
    if (best === null || rank < best.rank || (rank === best.rank && score > best.specificity)) {
      best = { rule, rank, specificity: score };
    }
  }
  if (best === null) return { decision: 'none', ruleId: null, pattern: null };
  return {
    decision: best.rule.effect === 'allow' ? 'allow' : 'deny',
    ruleId: best.rule.id,
    pattern: best.rule.pattern,
  };
}

/**
 * Why a message was passed or dropped, stored on the row so the audit view can explain it.
 *
 * `job_sender`, `vocabulary` and `thread` are rules 4, 5 and 6: the positive passes, which Plan 2
 * Task 3 starts producing and which are the only passes Stage 2's gate is allowed to see
 * (lib/triageGate). `ai_gate` is what the gate itself writes when it drops a message.
 */
export type TriageRule =
  | 'allow_list'
  | 'deny_list'
  | 'consumer_domain'
  | 'unreadable_sender'
  | 'own_address'
  | 'private_content'
  | 'job_sender'
  | 'vocabulary'
  | 'thread'
  | 'ai_gate'
  | 'no_signal'
  | 'none';

export interface TriageVerdict {
  decision: 'pass' | 'drop';
  matchedRule: TriageRule;
  /** The user rule that decided, when one did. */
  ruleId: string | null;
  pattern: string | null;
  /**
   * Which term decided, for the rules that match text rather than a rule row: the private
   * content signal, or the job word. It is the app's own vocabulary, never anything the message
   * said, so a filtered row can explain itself while keeping no content.
   */
  signal?: string | null;
}

/**
 * The Stage 1 verdict for one sender. `consumerVeto` is the user's rule 2 toggle.
 *
 * An address the parser cannot read PASSES, and is marked so the blocked view can still
 * account for it. Fail open, toward the human: the spec says a gate must never silently
 * swallow a recruiter email, and `senderAddress` deliberately returns '' for any From header
 * it will not vouch for, including legitimate ones such as a header carrying two mailboxes.
 * Dropping those would hide real mail to defend against rules that cannot match them anyway.
 */
export function triageSender(
  address: string,
  rules: MailFilterRuleRow[],
  consumerVeto: boolean,
  /** The account's own address, exempt from every heuristic (spec D1). */
  selfAddress?: string | null,
): TriageVerdict {
  const text = address.trim().toLowerCase();
  if (text.length === 0 || parseMailPattern(text) === null) {
    return { decision: 'pass', matchedRule: 'unreadable_sender', ruleId: null, pattern: null };
  }

  // The user's own mail, and anything they copy to themselves, is never filtered. Implicit
  // rather than a seeded allow rule: it cannot be deleted, and for an account at a consumer
  // provider a `*@gmail.com` seed would have exempted every Gmail sender on earth.
  if (selfAddress !== undefined && selfAddress !== null && text === selfAddress.toLowerCase()) {
    return { decision: 'pass', matchedRule: 'own_address', ruleId: null, pattern: null };
  }

  const verdict = evaluateRules(text, rules);
  if (verdict.decision === 'allow') {
    return {
      decision: 'pass',
      matchedRule: 'allow_list',
      ruleId: verdict.ruleId,
      pattern: verdict.pattern,
    };
  }
  if (verdict.decision === 'deny') {
    return {
      decision: 'drop',
      matchedRule: 'deny_list',
      ruleId: verdict.ruleId,
      pattern: verdict.pattern,
    };
  }
  if (consumerVeto && isConsumerAddress(text)) {
    return { decision: 'drop', matchedRule: 'consumer_domain', ruleId: null, pattern: null };
  }
  return { decision: 'pass', matchedRule: 'none', ruleId: null, pattern: null };
}

/**
 * Rule 4: does this sender belong to the built-in job sender list, or the user's own additions.
 *
 * Note that `evaluateRules` deliberately ignores `job_sender` rows: there, an effect that
 * outranked the vetoes would be wrong, since rule 4 sits BELOW both of them. This is where the
 * effect means something, and the two readings of the same rows are what keeps the order honest.
 *
 * A `job_sender` row that is disabled suppresses the built-in with the same pattern (decision
 * D-3), which is how a list that ships in code stays the user's to edit.
 */
export function isJobSender(address: string, rules: MailFilterRuleRow[]): boolean {
  const disabled = new Set<string>();
  for (const r of rules) {
    if (r.effect !== 'job_sender' || r.enabled) continue;
    disabled.add(r.pattern);
  }
  for (const r of rules) {
    if (r.effect !== 'job_sender' || !r.enabled) continue;
    const parsed = parseMailPattern(r.pattern);
    if (parsed !== null && matchesMailPattern(address, parsed)) return true;
  }
  return matchesJobSenderSeed(address, disabled);
}

export interface TriageMessageInput {
  address: string;
  subject: string;
  body: string;
  rules: MailFilterRuleRow[];
  consumerVeto: boolean;
  /** The account's own address, exempt from every heuristic (spec D1). */
  selfAddress: string | null;
  /** True when this message's thread is already linked to an opportunity (rule 6). */
  threadLinked: boolean;
  /**
   * True when the sender is one of the user's alert-digest senders, which is rule 4's second
   * half (spec D1 lists `job_senders` and `alert_senders` together there).
   *
   * It is an input rather than something this module looks up, because the list is a user
   * setting and this function does no IO. It matters more than it looks: a digest is parsed
   * locally into discovery leads, and its body is a list of postings that need not contain any
   * of rule 5's words, so without this rule 7 would drop it and Discovery would quietly empty.
   */
  digestSender: boolean;
}

/**
 * The full Stage 1 verdict for one message (spec D1 rules 0 to 7). Local, deterministic, no IO.
 *
 * The order is the design, and the two places it is subtle are both about rule 3:
 *
 *   3a, the private-content SENDER signal, yields to rule 4. One domain can carry both a
 *       hiring event and benefit records, and when the user has said that domain sends job
 *       mail, the domain's shape is the weaker evidence.
 *   3b, the private-content CONTENT signal, yields to nothing below rule 2. A message that says
 *       "claim number" is a benefit record even when it arrives from a known job sender, and
 *       that is exactly the case a pass list would otherwise wave through.
 *
 * Rule 0 is above both: an allow rule is the user's explicit instruction about a sender, and no
 * heuristic overrules it.
 */
export function triageMessage(input: TriageMessageInput): TriageVerdict {
  // Rule 2 yields to a thread the user linked to an opportunity (Brian's decision, 2026-10-19).
  // Three referral conversations from personal Gmail accounts were the reason: linking the
  // thread is the user's own act, as deliberate as an allow rule and not something a stranger
  // can trigger. The private-content vetoes stay ABOVE this, so a linked thread does not become
  // a way for medical or financial mail to be kept.
  const sender = triageSender(
    input.address,
    input.rules,
    input.consumerVeto && !input.threadLinked,
    input.selfAddress,
  );
  // Rules 0, 1, 2 and the unreadable-sender and own-address exemptions have already decided.
  if (sender.matchedRule !== 'none') return sender;

  const text = `${input.subject}\n${input.body}`;
  const content = privateContentSignal(text);
  const jobSender =
    input.digestSender || isJobSender(input.address.trim().toLowerCase(), input.rules);

  // 3b: drops even when rule 4 would pass.
  if (content !== null) {
    return {
      decision: 'drop',
      matchedRule: 'private_content',
      ruleId: null,
      pattern: null,
      signal: content,
    };
  }
  // 3a: drops unless rule 4 passes.
  const senderSignal = privateSenderSignal(input.address);
  if (senderSignal !== null && !jobSender) {
    return {
      decision: 'drop',
      matchedRule: 'private_content',
      ruleId: null,
      pattern: null,
      signal: senderSignal,
    };
  }
  if (jobSender) {
    return { decision: 'pass', matchedRule: 'job_sender', ruleId: null, pattern: null };
  }
  const vocabulary = jobVocabularySignal(text);
  if (vocabulary !== null) {
    return {
      decision: 'pass',
      matchedRule: 'vocabulary',
      ruleId: null,
      pattern: null,
      signal: vocabulary,
    };
  }
  if (input.threadLinked) {
    return { decision: 'pass', matchedRule: 'thread', ruleId: null, pattern: null };
  }
  // Rule 7. This is the rule that keeps an appointment reminder out, not rule 3: a message with
  // no job signal anywhere in it is not job mail, whatever its sender looks like.
  return { decision: 'drop', matchedRule: 'no_signal', ruleId: null, pattern: null };
}
