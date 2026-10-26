// Stage 2 of the mail funnel (spec D1): one cheap model asked one question about a message
// Stage 1 passed, consulted inside ingest BEFORE anything is written. A drop here is not a
// deletion: the caller writes the same contentless row rules 1 to 7 write, so there is nothing
// on disk to clean up and nothing to get wrong if the process dies halfway through.
//
// Two boundaries live in this module, and they are the reasons it is allowed to exist:
//
//   gateApplies  decides WHO the model sees. It is an allow list of the positive Stage 1 passes,
//                deliberately not a deny list of exemptions: a pass rule added later does not
//                silently start feeding mail to a model until someone adds it here on purpose.
//   gateMessage  decides what happens when the model cannot answer. Every failure is a pass.
//                A gate that drops mail while it is broken swallows recruiter email silently,
//                which is worse than no gate at all.
import {
  renderPrompt,
  runStructured,
  TriageOutputSchema,
  type TriageOutput as AiTriageOutput,
} from '@opportun/ai';
import type { Db } from '../db/client';
import type { UserCtx } from '../repos/base';
import { getActivePrompt } from '../repos/prompts';
import { buildAiDeps } from './ai';
import type { TriageVerdict, TriageRule } from './mailTriage';
import { line } from './promptText';

export type TriageOutput = AiTriageOutput;

/** How much of the body the gate is given. The rest never leaves the machine. */
export const GATE_INPUT_CHARS = 500;

/** Below this the model is not sure enough to overrule Stage 1, so the message passes. */
export const GATE_MIN_CONFIDENCE = 0.5;

/**
 * The Stage 1 passes the gate is consulted about: rules 4, 5 and 6. Everything else bypasses it.
 *
 * Rule 0 (`allow_list`) and `own_address` are the user's own instructions, which a model does not
 * get to overrule. `unreadable_sender` is already a fail-open pass with no address to reason
 * about. `none` is the pre-Plan-2 default pass and becomes rule 7's drop, so once rules 3 to 7
 * exist no message without a job signal reaches this gate: the appointment reminder that started
 * this design is refused by the rules, not shown to a model and refused by it.
 */
const GATED_RULES: ReadonlySet<TriageRule> = new Set<TriageRule>([
  'job_sender',
  'vocabulary',
  'thread',
]);

/**
 * Whether Stage 2 may look at this message at all. `isDigestSender` is the user's own
 * alert-digest sender list: those are parsed locally into discovery leads and never classified,
 * so asking a model about them spends money to risk emptying Discovery.
 */
export function gateApplies(verdict: TriageVerdict, isDigestSender: boolean): boolean {
  if (verdict.decision !== 'pass') return false;
  if (isDigestSender) return false;
  return GATED_RULES.has(verdict.matchedRule);
}

export type GateWhy =
  'job_related' | 'not_job_related' | 'low_confidence' | 'no_prompt' | 'unavailable';

export interface GateOutcome {
  decision: 'pass' | 'drop';
  /** A code, never the model's words: a dropped row keeps no content, including the reason. */
  why: GateWhy;
}

export interface GateInput {
  from: string;
  subject: string;
  body: string;
}

/** Everything the gate is told, which is a header pair and a bounded head of the body. */
export function gateText(input: GateInput): string {
  return [
    `From: ${line(input.from)}`,
    `Subject: ${line(input.subject)}`,
    '',
    input.body.slice(0, GATE_INPUT_CHARS),
  ].join('\n');
}

const PASS = (why: GateWhy): GateOutcome => ({ decision: 'pass', why });

/**
 * Asks the gate about one message. Call `gateApplies` first: this function does not re-check
 * who it is being asked about.
 *
 * **The whole body is inside the try**, which is the point rather than an accident. The gate is
 * consulted inside ingest, so an exception escaping here does not merely fail the gate: it fails
 * the delivery, and a connector batch of 50 messages answers 500 and stores none of them. Only a
 * confident `jobRelated: false` is allowed to stop a message, and nothing else that happens in
 * this function may stop one.
 */
export async function gateMessage(db: Db, ctx: UserCtx, input: GateInput): Promise<GateOutcome> {
  try {
    const prompt = await getActivePrompt(db, ctx, 'comms.triage');
    if (prompt === undefined) return PASS('no_prompt');
    const system = renderPrompt(prompt.body, { message_untrusted: gateText(input) });
    const output: TriageOutput = await runStructured(await buildAiDeps(db, ctx), 'comms.triage', {
      system,
      prompt: 'Decide whether this message is part of the job search.',
      schema: TriageOutputSchema,
      promptId: prompt.id,
    });
    if (output.confidence < GATE_MIN_CONFIDENCE) return PASS('low_confidence');
    if (output.jobRelated) return PASS('job_related');
    return { decision: 'drop', why: 'not_job_related' };
  } catch {
    // Every failure mode lands here on purpose: no key, budget spent, provider error, output
    // that did not validate, a prompt that would not render, a database read that failed. None
    // of them is a reason to hide a message from the user, or to refuse the delivery.
    return PASS('unavailable');
  }
}
