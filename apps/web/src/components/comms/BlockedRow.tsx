// One message Stage 1 kept out (spec D6). Deliberately not an InboxRow: a blocked row has no
// subject, no snippet and no body, so the ordinary row would render "(no subject)" and offer
// Reclassify and Link actions against content Opportun does not have.
//
// What it shows is the whole point: who it was from, when, and which rule decided, plus a link
// to the original where it still lives. That is enough to recognize a sender filtered by
// mistake and go fix the rule, without Opportun storing what the message said.
import { GATE_INPUT_CHARS } from '@opportun/core';
import type { CommunicationView } from './api';
import { OpenOriginal } from './OpenOriginal';

/**
 * Every rule that can decide, in the user's words rather than the code's. A rule with no label
 * here would show the user a bare identifier, so the funnel's rules are all listed: rules 0 to 2
 * from Plan 1, rules 3 to 7 from Plan 2, and the Stage 2 gate.
 */
const RULE_LABELS: Record<string, string> = {
  allow_list: 'your allow list',
  deny_list: 'your deny list',
  consumer_domain: 'personal email provider',
  unreadable_sender: 'sender could not be read',
  private_content: 'looks like medical, financial or personal mail',
  job_sender: 'a known job sender',
  vocabulary: 'job wording in the message',
  thread: 'a thread linked to an opportunity',
  ai_gate: 'not part of the job search',
  no_signal: 'nothing in it about a job',
  none: 'no rule',
};

/**
 * What a blocked row keeps, said once for the Blocked tab's note (Inbox.tsx) and for the AI check's
 * rows. It is what repos/communications.ts upsertInbound stores for a filtered message: the sender
 * and recipients, the date, the rule, and the channel, message and thread ids that link back to the
 * original; the subject, snippet, body and ATS links are blanked. apps/server/test/mailIngest.test.ts
 * ("what a blocked row keeps") pins those fields, so a change there has to change this sentence too
 * (https://github.com/bgoleno/opportun/issues/104, sec's review on #110).
 */
export const STORED_ON_BLOCK =
  'Opportun stored who sent it and to whom, when, the rule that decided and the ids that link back to the original, never the subject or the message.';

/**
 * What was read before an `ai_gate` block (https://github.com/bgoleno/opportun/issues/104). A mail
 * filter rule runs on the user's own server and sends the message nowhere (some rules read its
 * subject and body there), which the Blocked tab's note says. The AI check (lib/triageGate.ts on
 * the server) is different: the user's AI provider was given the sender, the subject and the
 * first GATE_INPUT_CHARS characters to decide. The row says so in the user guide's words.
 */
const AI_GATE_READ = `Your AI provider read the sender, the subject and the first ${GATE_INPUT_CHARS} characters to decide. ${STORED_ON_BLOCK}`;

const when = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export function BlockedRow({ comm }: { comm: CommunicationView }) {
  const reason = RULE_LABELS[comm.triageRule ?? 'none'] ?? comm.triageRule;

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border bg-card p-4">
      {/* break-all: an address is one unbroken token, and a long one would otherwise run off a phone. */}
      <span className="min-w-0 break-all font-mono text-sm">{comm.from}</span>
      <span className="text-xs text-muted-foreground">{when(comm.sentAt)}</span>
      <span className="text-xs text-muted-foreground">blocked by {reason}</span>
      {/* The one place a blocked message can be read is where it already is. */}
      <OpenOriginal comm={comm} />
      {comm.triageRule === 'ai_gate' ? (
        <p className="basis-full text-xs text-muted-foreground">{AI_GATE_READ}</p>
      ) : null}
    </li>
  );
}
