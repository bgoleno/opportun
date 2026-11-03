// The evidence card for an email confirmation (#119): what the match rested on, shown so the user
// can judge it, and the way to undo it. Never the body (NFR-PRV5): the server sends only the
// subject, the sender's address without its display name, when it was sent, and signal names.
// The sender's address is not proof of who sent it (sec on #128), which is why the signals are
// spelled out and the unlink is one step away.
import type { SubmissionConfirmationSignal } from '@opportun/core';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/opportunities';
import { useUnlinkConfirmation, type SubmissionView } from './api';

const SIGNAL_WORDS = new Map<SubmissionConfirmationSignal, string>([
  ['ats_job_ref', "this job's id in a link"],
  ['ats_board', "the company's job board in a link"],
  ['sender_domain', "the sender's address is at the company's domain"],
  ['role_and_company', 'the role and the company are named'],
  ['time_window', 'sent soon after you applied'],
]);

/** "Matched on: …", in the user's words. */
export function signalSummary(signals: readonly SubmissionConfirmationSignal[]): string {
  return signals.map((s) => SIGNAL_WORDS.get(s) ?? s).join('; ');
}

export function EmailEvidence({ attempt }: { attempt: SubmissionView }) {
  const unlink = useUnlinkConfirmation(attempt.opportunityId);
  const [asking, setAsking] = useState(false);
  const email = attempt.confirmationEmail ?? null;
  return (
    <div className="grid gap-3 text-sm">
      <p>A confirmation email backs this up.</p>
      {email === null ? null : (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Subject</dt>
          <dd className="break-words">{email.subject ?? '(no subject)'}</dd>
          <dt className="text-muted-foreground">From</dt>
          <dd className="break-all">
            {email.fromAddress === '' ? '(unreadable)' : email.fromAddress}
          </dd>
          <dt className="text-muted-foreground">Sent</dt>
          <dd>{formatDateTime(email.sentAt)}</dd>
          <dt className="text-muted-foreground">Matched on</dt>
          <dd>{signalSummary(email.signals)}</dd>
        </dl>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() => setAsking(true)}
      >
        Not this application (unlink)
      </Button>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title="Unlink this email?"
        description="This application goes back to waiting for a confirmation. The email stays in your inbox here."
        confirmLabel="Unlink"
        onConfirm={async () => {
          await unlink.mutateAsync(attempt.id);
        }}
      />
    </div>
  );
}
