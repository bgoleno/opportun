import { Link } from '@tanstack/react-router';
import { ArrowRight, Ban, Link2, Mail, ShieldCheck, Tags } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { formatDateTime, isTerminal, stageLabel } from '@/lib/opportunities';
import {
  channelLabel,
  classificationLabel,
  outreachLabel,
  useAcceptTransition,
  useDismissProposal,
  useReclassify,
  type CommunicationView,
} from './api';
import { LinkDialog } from './LinkDialog';
import { MessageDialog } from './MessageDialog';
import { OpenOriginal } from './OpenOriginal';
import { ReclassifyDialog } from './ReclassifyDialog';
import { RejectDialog } from './RejectDialog';
import { ReopenDialog } from './ReopenDialog';

/** Which actions a row offers depends on the inbox tab it is shown in. */
export type RowMode = 'review' | 'linked' | 'spam' | 'filtered' | 'opportunity';

/**
 * One message: sender, subject, snippet and its classification, with the actions the user can
 * take on it. Message content is shown as text only (it is third-party data).
 */
export function InboxRow({
  comm,
  mode,
  selected,
  onSelect,
}: {
  comm: CommunicationView;
  mode: RowMode;
  /** When onSelect is given, a leading checkbox is shown for bulk selection (#inbox bulk). */
  selected?: boolean | undefined;
  onSelect?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState<'message' | 'link' | 'reclassify' | 'reopen' | 'reject' | null>(
    null,
  );
  const accept = useAcceptTransition();
  const dismiss = useDismissProposal();
  const reclassify = useReclassify();
  const subject = comm.subject?.trim() || '(no subject)';
  // The server already suppresses a proposal the opportunity reached by some other route
  // (issue #143), but a row already sitting in the client's cache from before that refetch
  // has not; guard here too so it does not keep offering a no-op until the next one.
  const overtakenStage =
    comm.proposedTransition !== null && comm.proposedTransition === comm.opportunityStage
      ? comm.proposedTransition
      : null;
  const proposal = overtakenStage !== null ? null : comm.proposedTransition;
  // Leaving closed or dismissed for a chain stage is a reopen the user confirms explicitly.
  const needsReopen =
    proposal !== null &&
    comm.opportunityStage !== null &&
    isTerminal(comm.opportunityStage) &&
    !isTerminal(proposal);

  function acceptProposal(reopen: boolean) {
    accept.mutate(
      { id: comm.id, reopen },
      {
        onSuccess: (res) =>
          toast({
            title: `Moved to ${stageLabel(res.stage)}`,
            description: comm.opportunityTitle ?? undefined,
            variant: 'success',
          }),
        onError: (err) =>
          toast({
            title: 'Stage not changed',
            description: errorMessage(err),
            variant: 'destructive',
          }),
      },
    );
  }

  function notSpam() {
    reclassify.mutate(
      { id: comm.id, input: { classification: 'solicitation', outreachKind: 'targeted' } },
      {
        onSuccess: () => toast({ title: 'Moved to Needs review', variant: 'success' }),
        onError: (err) =>
          toast({ title: 'Not changed', description: errorMessage(err), variant: 'destructive' }),
      },
    );
  }

  return (
    <li
      className={
        onSelect
          ? 'flex items-start gap-3 rounded-xl border bg-card p-4'
          : 'grid grid-cols-1 gap-2 rounded-xl border bg-card p-4'
      }
      aria-label={subject}
    >
      {onSelect ? (
        <Checkbox
          className="mt-1"
          checked={selected ?? false}
          onCheckedChange={() => onSelect()}
          aria-label={`Select message from ${comm.from}`}
        />
      ) : null}
      {/* display:contents keeps the original grid layout for the message body whether or not a
          checkbox is present, so a row reads the same selectable or not. */}
      <div className={onSelect ? 'grid min-w-0 flex-1 grid-cols-1 gap-2' : 'contents'}>
        <div className="flex flex-wrap items-center gap-2">
          {comm.classification ? (
            <Badge variant="secondary">{classificationLabel(comm.classification)}</Badge>
          ) : (
            <Badge variant="outline">Unclassified</Badge>
          )}
          {comm.outreachKind ? (
            <Badge variant="outline">{outreachLabel(comm.outreachKind)}</Badge>
          ) : null}
          {comm.confidence !== null && comm.confidence < 0.5 ? (
            <Badge variant="outline">Low confidence</Badge>
          ) : null}
          {comm.bodySource === 'snippet' ? (
            // Issue #149: most messages are classified on the full text and should not say so;
            // this is the one case where what the classifier read is worth a glance, the same
            // way low confidence already is.
            <Badge variant="outline" title="Classified from the message preview, not the full text">
              From snippet
            </Badge>
          ) : null}
          <Badge variant="outline" title="Source">
            {channelLabel(comm.channel)}
          </Badge>
          <span className="min-w-0 truncate text-sm text-muted-foreground">{comm.from}</span>
          <time
            dateTime={new Date(comm.sentAt).toISOString()}
            className="ml-auto text-xs text-muted-foreground"
          >
            {formatDateTime(comm.sentAt)}
          </time>
        </div>
        <button
          type="button"
          className="w-fit max-w-full break-words text-left text-sm font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setOpen('message')}
        >
          {subject}
        </button>
        {comm.snippet ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">{comm.snippet}</p>
        ) : null}
        {mode === 'filtered' && comm.mismatchReason ? (
          <p className="text-sm">
            <span className="text-muted-foreground">Why it was filtered: </span>
            {comm.mismatchReason}
          </p>
        ) : null}
        {comm.opportunityId && mode !== 'opportunity' ? (
          <p className="text-sm text-muted-foreground">
            Linked to{' '}
            <Link
              to="/opportunities/$id"
              params={{ id: comm.opportunityId }}
              className="font-medium text-foreground underline underline-offset-2"
            >
              {comm.opportunityTitle}
              {comm.companyName ? ` at ${comm.companyName}` : ''}
            </Link>
            {comm.opportunityStage ? ` (${stageLabel(comm.opportunityStage)})` : ''}
          </p>
        ) : null}
        {proposal ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed px-3 py-2">
            <span className="text-sm">Suggested stage</span>
            <Badge>
              <ArrowRight aria-hidden="true" />
              {stageLabel(proposal)}
            </Badge>
            <div className="ml-auto flex gap-2">
              <Button
                size="sm"
                disabled={accept.isPending}
                onClick={() => (needsReopen ? setOpen('reopen') : acceptProposal(false))}
              >
                {needsReopen ? 'Reopen and move' : `Move to ${stageLabel(proposal)}`}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={dismiss.isPending}
                onClick={() => dismiss.mutate(comm.id)}
              >
                Ignore
              </Button>
            </div>
          </div>
        ) : overtakenStage !== null ? (
          // A proposal that has been overtaken is not the same as one that was never made: it
          // once suggested something real. Saying so in a muted line keeps the card honest about
          // why the button is gone, rather than leaving someone who remembers seeing it to wonder
          // whether they imagined it.
          <p className="text-xs text-muted-foreground">
            This message once suggested moving to {stageLabel(overtakenStage)}; the opportunity is
            already there.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setOpen('message')}>
            <Mail aria-hidden="true" />
            Open
          </Button>
          {mode === 'spam' ? (
            <Button size="sm" variant="outline" disabled={reclassify.isPending} onClick={notSpam}>
              <ShieldCheck aria-hidden="true" />
              Not spam
            </Button>
          ) : null}
          {mode !== 'spam' ? (
            <Button size="sm" variant="outline" onClick={() => setOpen('link')}>
              <Link2 aria-hidden="true" />
              {comm.opportunityId ? 'Change link' : 'Link to opportunity'}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => setOpen('reclassify')}>
            <Tags aria-hidden="true" />
            Reclassify
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen('reject')}>
            <Ban aria-hidden="true" />
            Reject
          </Button>
          {/* The message itself is not here to open: it is where it arrived (spec D2). */}
          <OpenOriginal comm={comm} />
        </div>
        <MessageDialog
          comm={comm}
          open={open === 'message'}
          onOpenChange={(o) => setOpen(o ? 'message' : null)}
        />
        <LinkDialog
          comm={comm}
          open={open === 'link'}
          onOpenChange={(o) => setOpen(o ? 'link' : null)}
        />
        <ReclassifyDialog
          comm={comm}
          open={open === 'reclassify'}
          onOpenChange={(o) => setOpen(o ? 'reclassify' : null)}
        />
        <RejectDialog
          comm={comm}
          open={open === 'reject'}
          onOpenChange={(o) => setOpen(o ? 'reject' : null)}
        />
        {proposal && comm.opportunityStage ? (
          <ReopenDialog
            open={open === 'reopen'}
            onOpenChange={(o) => setOpen(o ? 'reopen' : null)}
            from={comm.opportunityStage}
            to={proposal}
            title={comm.opportunityTitle ?? 'this opportunity'}
            onConfirm={() => acceptProposal(true)}
          />
        ) : null}
      </div>
    </li>
  );
}
