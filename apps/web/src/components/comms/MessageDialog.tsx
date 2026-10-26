import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatDateTime } from '@/lib/opportunities';
import { type CommunicationView } from './api';
import { mailLink } from './mailLink';
import { OpenOriginal } from './OpenOriginal';

/**
 * What Opportun kept of a message: its headers and the snippet. The body is deliberately not
 * stored (Plan 3), so there is nothing to fetch and nothing to show in its place. The message
 * itself is still in the user's mailbox, and Task 3 puts the link to it here.
 */
export function MessageDialog(props: {
  comm: CommunicationView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { comm } = props;
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{comm.subject?.trim() || '(no subject)'}</DialogTitle>
          <DialogDescription>
            From {comm.from}
            {comm.to.length > 0 ? ` to ${comm.to.join(', ')}` : ''}, {formatDateTime(comm.sentAt)}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto rounded-md border bg-muted/40 p-3">
          <p className="text-sm break-words whitespace-pre-wrap">
            {comm.snippet ?? 'This message has no text.'}
          </p>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Opportun keeps this much of a message and no more.
            {/* #137: true for Gmail and Apple Mail, false for a LinkedIn export, which has no
                mailbox copy at all. OpenOriginal's own explanation (below, explain) covers the
                no-link case instead of this sentence overclaiming one. */}
            {mailLink(comm) !== null ? ' The message itself is in your mailbox.' : ''}
          </p>
          <OpenOriginal comm={comm} label="Read it in your mail" explain />
        </div>
      </DialogContent>
    </Dialog>
  );
}
