// Asking before a posting replaces a description the user wrote
// (https://github.com/bgoleno/opportun/issues/858). Only at `edited`: everywhere else the server
// keeps their description, or refuses. It keeps it there too unless the request carries the answer.
import { sha256Hex } from '@opportun/core';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import type { OpportunityView } from '@/lib/opportunities';

/**
 * The fingerprint of the user's text that a posting would replace, or null when there is none to
 * ask about. Taken when the question is asked, and sent with the answer: text saved since then was
 * not asked about, and the server keeps it. (core's own SHA-256: `crypto.subtle` is missing on a
 * plain-http address other than localhost, where some instances run.)
 */
export function descriptionAtStake(opp: OpportunityView): string | null {
  const edited = opp.postingState === 'needs_review' && opp.postingStateDetail === 'edited';
  if (!edited || !opp.descriptionIsUserWritten || opp.descriptionMd == null) return null;
  return sha256Hex(opp.descriptionMd);
}

const WHAT = {
  board: {
    confirmLabel: 'Find and replace',
    description:
      "You've edited this description by hand. If the posting is found on the company's board, the board's copy replaces it, and your edit can't be recovered afterward.",
  },
  paste: {
    confirmLabel: 'Replace',
    description:
      "You've edited this description by hand. Attaching this posting replaces it, and your edit can't be recovered afterward.",
  },
} as const;

export function ReplaceDescriptionDialog(props: {
  open: boolean;
  /** Where the text that replaces it comes from. */
  from: keyof typeof WHAT;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void> | void;
}) {
  return (
    <ConfirmDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Replace your description?"
      {...WHAT[props.from]}
      onConfirm={props.onConfirm}
    />
  );
}
