// How far the search for this posting on the company's own job board got (design D9, D13).
//
// The background job changes nothing when it cannot settle the posting: several plausible rows
// on the board, no match, or no board at all. "Leave it alone and flag it for me to resolve"
// (owner decision, 2026-10-19). This is the flag, in the Description card where the content it is about
// lives; the pipeline card carries a smaller mark so it is visible without opening anything.
//
// The action here replaces the Find posting button, which rendered only while the description
// was empty. A capture makes that permanently false, so the button would have vanished exactly
// when it is needed.
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';
import type { OpportunityView } from '@/lib/opportunities';

/** The one line each state says, what the button that follows it offers, and whether a user
 *  who checked for themselves can confirm it instead (issue #250) -- every detail except
 *  `edited`, which already has its own resolution (Review board copy) and would otherwise get
 *  a second button saying the same thing a different way. */
const COPY: Record<string, { text: string; action?: string; confirmable?: boolean }> = {
  searching: { text: "Checking the company's job board for this posting." },
  ambiguous: {
    text: "Several postings on the company's board could be this one.",
    action: 'Choose posting',
    confirmable: true,
  },
  none_found: {
    text: "This posting is not on the company's board right now.",
    action: 'Look again',
    confirmable: true,
  },
  no_board: {
    text: 'No job board found for this company.',
    action: 'Add board',
    confirmable: true,
  },
  failed: {
    text: "The check against the company's job board did not finish.",
    action: 'Try again',
    confirmable: true,
  },
  edited: {
    text: 'You edited this description, so the board copy was not merged in.',
    action: 'Review board copy',
  },
};

export function PostingStateBanner(props: {
  opp: OpportunityView;
  onAction?: () => void;
  onConfirm?: () => void;
  busy?: boolean;
  confirmBusy?: boolean;
}) {
  const { opp } = props;
  if (opp.postingState == null || opp.postingState === 'confirmed') return null;
  const key = opp.postingState === 'searching' ? 'searching' : (opp.postingStateDetail ?? '');
  // eslint-disable-next-line security/detect-object-injection -- key comes from a typed enum
  const copy = COPY[key];
  if (copy === undefined) return null;

  const searching = opp.postingState === 'searching';
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
    >
      {searching ? (
        <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
      ) : (
        <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
      )}
      <span className="flex-1">{copy.text}</span>
      {copy.action === undefined ? null : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={props.busy === true}
          onClick={props.onAction}
        >
          {props.busy === true ? 'Searching...' : copy.action}
        </Button>
      )}
      {copy.confirmable === true ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={props.confirmBusy === true}
          onClick={props.onConfirm}
        >
          {props.confirmBusy === true ? 'Confirming...' : 'Confirm'}
        </Button>
      ) : null}
    </div>
  );
}

/** The pipeline card's mark: present only when the posting needs the user to resolve it. */
export function postingNeedsReview(opp: OpportunityView): boolean {
  return opp.postingState === 'needs_review';
}

/**
 * Shown where the banner renders nothing (issue #255): `postingState === 'confirmed'` means
 * settled, not "nothing to say". A quiet provenance line, not the amber banner -- a confirmed
 * posting is not a thing that needs attention -- plus Refetch, which re-runs the same search
 * `/find-posting` already does (Look again, Try again, Add board all use it); the gap this
 * closes is that nothing ever offered it once a posting was confirmed.
 *
 * Always confirms before firing, worded by whether the current description is the user's own
 * writing: warned before the request goes out, not only after a 409 the server would otherwise
 * refuse it with.
 */
export function PostingConfirmedStatus(props: {
  opp: OpportunityView;
  onRefetch: () => void;
  onUndo?: () => void;
  busy?: boolean;
  undoBusy?: boolean;
}) {
  const { opp } = props;
  const [confirming, setConfirming] = useState(false);
  if (opp.postingState !== 'confirmed') return null;
  // Issue #250: the one case a user, not the board, settled it.
  const byUser = opp.postingStateDetail === 'user_confirmed';
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span className="flex-1">
          {byUser ? 'Confirmed by you.' : "Matched on the company's board."}
        </span>
        {byUser ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={props.undoBusy === true}
            onClick={props.onUndo}
          >
            {props.undoBusy === true ? 'Undoing...' : 'Undo'}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={props.busy === true}
          onClick={() => setConfirming(true)}
        >
          {props.busy === true ? 'Searching...' : 'Refetch'}
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Refetch this posting?"
        description={
          opp.descriptionIsUserWritten
            ? "You've edited this description by hand. Refetching replaces it with a fresh copy from the company's board, and your edit can't be recovered afterward."
            : "This replaces the current description with a fresh copy from the company's board. If nothing is found, the description is left exactly as it is."
        }
        confirmLabel="Refetch"
        onConfirm={() => props.onRefetch()}
      />
    </>
  );
}

/**
 * "Re-derive from capture" (issue #264): a quiet, last-resort action, shown whenever this
 * opportunity has a stored capture on its timeline, independent of postingState -- unlike
 * Refetch (#255), which only helps a company with a readable board. The gap this closes is a
 * description corrupted by something unrelated to the board search (#238), or a company with no
 * ATS board at all, for which Refetch finds nothing and leaves the description untouched. The
 * server tries a board match first and merges it in as usual, falling back to the capture alone
 * only when no confident match exists, so this never trades a good merged description for a
 * worse one.
 *
 * Always confirms first, worded by whichever of two things it could silently overwrite applies:
 * the user's own writing, or a posting the user confirmed themselves (#250) -- the same
 * protection reconcile() already gives that confirmation against an automatic background run.
 */
export function RederiveFromCaptureAction(props: {
  opp: OpportunityView;
  onRederive: () => void;
  busy?: boolean;
}) {
  const { opp } = props;
  const [confirming, setConfirming] = useState(false);
  if (!opp.hasCapturedPage) return null;
  const userConfirmed =
    opp.postingState === 'confirmed' && opp.postingStateDetail === 'user_confirmed';
  const description = userConfirmed
    ? "You confirmed this posting yourself. Re-deriving replaces the description with one built from the captured page (and the company's board, if a confident match turns up), and your confirmation can't be recovered afterward."
    : opp.descriptionIsUserWritten
      ? "You've edited this description by hand. Re-deriving replaces it with one built from the captured page (and the company's board, if a confident match turns up), and your edit can't be recovered afterward."
      : "This replaces the current description with one built from the captured page already on this opportunity's timeline (and the company's board, if a confident match turns up).";
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span className="flex-1">
          A captured page is stored on this opportunity&apos;s timeline.
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={props.busy === true}
          onClick={() => setConfirming(true)}
        >
          {props.busy === true ? 'Re-deriving...' : 'Re-derive from capture'}
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Re-derive this description?"
        description={description}
        confirmLabel="Re-derive"
        onConfirm={() => props.onRederive()}
      />
    </>
  );
}
