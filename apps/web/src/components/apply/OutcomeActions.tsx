// What happened after the user submitted (assisted apply, https://github.com/bgoleno/opportun/issues/148;
// design Part B S7): "I saw a confirmation" and "The site refused it", for an attempt that is
// submitted or has no confirmation seen. Each dialog says exactly what will be recorded before
// the user confirms. Opportun sends nothing: these only record what the user saw.
import { useId, useState } from 'react';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import {
  submissionErrorText,
  useRecordOutcome,
  type ReportedOutcome,
  type SubmissionView,
} from './api';

/** The statuses an outcome can be reported from (the server's state machine). */
export const REPORTABLE: readonly string[] = ['submitted', 'unknown'];

const NOTE_MAX = 1000;

export function OutcomeActions({
  attempt,
  companyName,
}: {
  attempt: SubmissionView;
  companyName: string;
}) {
  const [open, setOpen] = useState<ReportedOutcome | null>(null);
  if (!REPORTABLE.includes(attempt.status)) return null;
  return (
    <div className="grid gap-2">
      {attempt.status === 'unknown' ? (
        <p className="text-sm text-muted-foreground">
          <strong className="font-medium text-foreground">No confirmation seen yet.</strong> This is
          not a failure. Many employers send nothing, and some emails land in spam.
        </p>
      ) : null}
      <p className="text-sm font-medium">What happened?</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setOpen('confirmed_by_user')}>
          I saw a confirmation
        </Button>
        <Button variant="outline" size="sm" onClick={() => setOpen('ats_refused')}>
          The site refused it
        </Button>
      </div>
      <OutcomeDialog
        outcome={open}
        onClose={() => setOpen(null)}
        attempt={attempt}
        companyName={companyName}
      />
    </div>
  );
}

function OutcomeDialog({
  outcome,
  onClose,
  attempt,
  companyName,
}: {
  outcome: ReportedOutcome | null;
  onClose: () => void;
  attempt: SubmissionView;
  companyName: string;
}) {
  const record = useRecordOutcome(attempt.opportunityId);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const noteId = useId();
  const refused = outcome === 'ats_refused';
  // Only an attempt with no confirmation seen has the follow-up's next step to close.
  const followUp =
    attempt.status === 'unknown'
      ? `Marks the next step “Check whether your application to ${companyName} was received” as done, if it is still open.`
      : null;

  function close() {
    setNote('');
    setError(null);
    onClose();
  }

  async function confirm() {
    if (outcome === null) return;
    setError(null);
    try {
      await record.mutateAsync({ id: attempt.id, outcome, ...(refused ? { note } : {}) });
      toast({
        title: refused ? 'Refusal recorded' : 'Confirmation recorded',
        variant: refused ? 'default' : 'success',
      });
      close();
    } catch (err) {
      setError(submissionErrorText(err));
    }
  }

  return (
    <Dialog
      open={outcome !== null}
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {refused ? 'Record that the site refused it?' : 'Mark as confirmed?'}
          </DialogTitle>
          <DialogDescription>
            {refused
              ? 'This records that the application site rejected the form. It is different from an employer declining you.'
              : 'This records that you saw a confirmation. No evidence will be attached.'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 text-sm">
          {refused ? (
            <div className="grid gap-1.5">
              <Label htmlFor={noteId}>What did the site say? (optional)</Label>
              <Textarea
                id={noteId}
                value={note}
                maxLength={NOTE_MAX}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          ) : null}
          <div className="grid gap-1">
            <p className="font-medium">This will:</p>
            <ul className="grid list-disc gap-1 pl-5 text-muted-foreground">
              <li>
                {refused
                  ? 'Add a note to the timeline: “The application site refused the form”, with what you write.'
                  : 'Add a note to the timeline: “Marked confirmed by you (no evidence attached)”.'}
              </li>
              {followUp !== null ? <li>{followUp}</li> : null}
              <li>Leave this opportunity’s stage as it is.</li>
            </ul>
          </div>
        </div>
        <FormError message={error} />
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Not now
          </Button>
          <Button disabled={record.isPending} onClick={() => void confirm()}>
            {refused ? 'Record refusal' : 'Mark confirmed'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
