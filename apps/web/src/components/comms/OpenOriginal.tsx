// The link back to a message where it actually lives (spec D2).
//
// This is the other half of not keeping anything: Opportun can hold a snippet instead of a
// message because the message is one click away in the mail client it arrived in. One component
// for every place that offers it, so the rules about when a link exists at all are written once.
import { ExternalLink } from 'lucide-react';
import { useGmailStatus } from './api';
import { mailLink, mailLinkMissingReason, type MailLinkSource } from './mailLink';

/**
 * Renders nothing when no link can be built and `explain` is off (the default), which is a
 * real case rather than an edge one: a message the Apple Mail connector identified by its own
 * fallback id (`mail-<rowid>`, `sha256:<hex>`) has no Message-ID to open, a LinkedIn export has
 * no mailbox copy at all, and a bad link is worse than none.
 */
export function OpenOriginal({
  comm,
  label = 'Open the original',
  explain = false,
}: {
  /**
   * Anything that knows which mailbox it came from and its id there: a communication row, or a
   * discovery lead naming the message it was parsed out of.
   */
  comm: MailLinkSource;
  label?: string;
  /**
   * Say why, instead of rendering nothing, when no link can be built (#137). Off by default:
   * a row in a list (InboxRow, BlockedRow) where most messages do have a link would turn into
   * a sentence of explanation on every row that doesn't, which is noise most rows don't need.
   * On for a dialog the person opened on purpose to read one specific message (MessageDialog,
   * discovery's QueueDialogs), where showing nothing with no explanation is the actual bug.
   */
  explain?: boolean;
}) {
  // The synced mailbox's address, so a Gmail link opens that mailbox rather than whichever
  // Google account the browser happens to have first (Review Focus 4). One shared query: every
  // row on the page reads the same cached status.
  const accountEmail = useGmailStatus().data?.accountEmail ?? null;
  const href = mailLink(comm, accountEmail);
  if (href !== null) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-xs underline"
      >
        <ExternalLink aria-hidden="true" className="size-3" />
        {label}
      </a>
    );
  }
  if (!explain) return null;
  return <p className="text-xs text-muted-foreground">{mailLinkMissingReason(comm)}</p>;
}
