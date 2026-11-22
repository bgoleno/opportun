// Whether a destination may be opened for a requisition (design 7.2;
// https://github.com/bgoleno/opportun/issues/763). Pure, so the submissions repo checks it without
// importing the review repo (repos/submissionReview.ts), which imports the submissions repo back.
import type { SubmissionRow } from '../repos/submissions';
import { boardFromUrl } from './atsBoard';
import { atsJobRefOfBoardPath, withoutTrailingPunctuation } from './atsJobRef';
import { isPageFetchProhibited } from './safeFetch';

/** Why a destination may not be opened for this requisition (design 7.2), or null. */
export type DestinationRefusal =
  | 'not_a_url'
  | 'not_https'
  | 'credentials'
  | 'prohibited_host'
  | 'not_ats_board'
  | 'other_board'
  | 'no_board'
  | 'not_this_posting'
  | 'trailing_characters';

/**
 * Why `destination` may not be opened for this requisition, or null when it may (design 7.2):
 * https only, no credentials, never a LinkedIn or Indeed host, and a recognised ATS posting URL
 * for this very requisition: the same ATS, the same requisition id, and the same board or tenant
 * where the attempt names one (a Workday requisition id is only unique within its tenant). A
 * company career page that embeds an ATS board is not accepted: nothing here can tell the
 * company's own host from a lookalike, which needs the M3 company-domain check.
 *
 * Each guard answers with its own reason so a test can pin it even where another guard would
 * also refuse (LinkedIn and Indeed are never a recognised board); the route answers them all
 * alike, 422 destination_not_allowed.
 */
export function destinationRefusal(
  destination: string,
  sub: Pick<SubmissionRow, 'atsKind' | 'atsExternalId' | 'atsRef'>,
): DestinationRefusal | null {
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    return 'not_a_url';
  }
  if (url.protocol !== 'https:') return 'not_https';
  if (url.username !== '' || url.password !== '') return 'credentials';
  if (isPageFetchProhibited(url.hostname)) return 'prohibited_host';
  // The address checked is the address opened (#620): the job reader drops trailing punctuation,
  // the page opened keeps it, so a destination the drop would change is refused.
  if (withoutTrailingPunctuation(destination) !== destination) return 'trailing_characters';
  // A recognised ATS board host, never a page that merely embeds a board: atsJobRefOfUrl also
  // reads `gh_jid` on any host, which is how a lookalike could name this requisition.
  const board = boardFromUrl(url.href);
  if (board === null) return 'not_ats_board';
  if (board.kind !== sub.atsKind) return 'other_board';
  // atsRef is the board the draft was created from (repos/submissions.ts): the same tenant. With
  // none, nothing can say this board is the attempt's, so nothing is opened (#620). Only a `gh_jid`
  // link on a company's own page has none, and its destination is no board (not_ats_board above).
  if (sub.atsRef === null) return 'no_board';
  if (board.slug.toLowerCase() !== sub.atsRef.toLowerCase()) return 'other_board';
  // The job this address names, from its own path only (#521, #620): a URL or a `gh_jid` in its
  // query names nothing here, nor does a board root or an embed page.
  const ref = atsJobRefOfBoardPath(url.href);
  const named = ref !== null && ref.kind === sub.atsKind && ref.externalId === sub.atsExternalId;
  return named ? null : 'not_this_posting';
}

/** Whether `destination` may be opened for this requisition (destinationRefusal is null). */
export function destinationAllowed(
  destination: string,
  sub: Pick<SubmissionRow, 'atsKind' | 'atsExternalId' | 'atsRef'>,
): boolean {
  return destinationRefusal(destination, sub) === null;
}
