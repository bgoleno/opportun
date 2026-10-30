// Reject as out of scope (spec D4), as a form so it can be tested without the query layer.
//
// Two things this form has to make legible, because getting them wrong is the harm the whole
// design exists to prevent: rejecting destroys the message's content rather than filing it,
// and a note is the user's own unless they choose to let it improve the filter, which means
// sending it to a model.
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

export type RejectionReason =
  | 'not_job_related'
  | 'medical_or_personal'
  | 'financial'
  | 'wrong_role'
  | 'wrong_company'
  | 'spam'
  | 'other';

export interface RejectPayload {
  reason: RejectionReason;
  note?: string | undefined;
  shareNote: boolean;
  neverIngest?: 'address' | 'domain' | undefined;
}

const REASONS: { value: RejectionReason; label: string }[] = [
  { value: 'not_job_related', label: 'Not about the job search' },
  { value: 'medical_or_personal', label: 'Medical or personal' },
  { value: 'financial', label: 'Financial' },
  { value: 'wrong_role', label: 'Wrong role' },
  { value: 'wrong_company', label: 'Wrong company' },
  { value: 'spam', label: 'Spam' },
  { value: 'other', label: 'Other' },
];

/** Private by nature: blocking the sender is the obvious next thing to want. */
const BLOCK_BY_DEFAULT: RejectionReason[] = ['medical_or_personal', 'financial'];

const domainOf = (sender: string): string => sender.slice(sender.lastIndexOf('@') + 1);

export function RejectForm(props: {
  sender: string;
  pending: boolean;
  onReject: (payload: RejectPayload) => void;
}) {
  const [reason, setReason] = useState<RejectionReason | ''>('');
  const [note, setNote] = useState('');
  const [shareNote, setShareNote] = useState(false);
  const [block, setBlock] = useState(false);
  const [scope, setScope] = useState<'address' | 'domain'>('domain');
  // The default follows the reason, but only until the user touches it themselves.
  const [blockTouched, setBlockTouched] = useState(false);
  const blocking = blockTouched ? block : reason !== '' && BLOCK_BY_DEFAULT.includes(reason);

  return (
    <div className="grid gap-4">
      <p className="text-xs text-muted-foreground" data-testid="reject-warning">
        Rejecting deletes this message's subject and body from Opportun and keeps only the sender
        and date, so the same message is not pulled in again. The original stays in your mailbox.
      </p>

      <div className="grid gap-2">
        <Label htmlFor="reject-reason">Why should this not be here?</Label>
        <Select
          id="reject-reason"
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value as RejectionReason | '')}
        >
          <option value="">Choose a reason</option>
          {REASONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="reject-note">Note (optional)</Label>
        <Textarea
          id="reject-note"
          rows={2}
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
        />
        <div className="flex items-start gap-2">
          <input
            id="reject-share"
            type="checkbox"
            className="mt-1 size-4"
            checked={shareNote}
            onChange={(e) => setShareNote(e.currentTarget.checked)}
          />
          <Label htmlFor="reject-share" className="text-xs font-normal">
            Use this note to improve the filter
          </Label>
        </div>
        <p className="text-xs text-muted-foreground" data-testid="share-note-warning">
          Off by default. Your note stays on this machine unless you tick this, which sends it to
          the AI that proposes filter improvements. The reason above is always used, and it never
          carries anything you typed.
        </p>
      </div>

      <div className="grid gap-2">
        <div className="flex items-center gap-2">
          <input
            id="reject-block"
            type="checkbox"
            className="size-4"
            checked={blocking}
            onChange={(e) => {
              setBlockTouched(true);
              setBlock(e.currentTarget.checked);
            }}
          />
          <Label htmlFor="reject-block">Never fetch mail from this sender again</Label>
        </div>
        {blocking ? (
          <div className="flex items-center gap-2">
            <Label htmlFor="reject-scope" className="text-xs font-normal">
              Block
            </Label>
            <Select
              id="reject-scope"
              className="w-64"
              value={scope}
              onChange={(e) => setScope(e.currentTarget.value as 'address' | 'domain')}
            >
              <option value="domain">everyone at {domainOf(props.sender)}</option>
              <option value="address">just {props.sender}</option>
            </Select>
          </div>
        ) : null}
      </div>

      {/* eslint-disable-next-line opportun/no-stretched-grid-button -- full width by default, not by decision: w-fit or w-full is still to be chosen (https://github.com/bgoleno/opportun/issues/9) */}
      <Button
        type="button"
        variant="destructive"
        disabled={props.pending || reason === ''}
        onClick={() => {
          if (reason === '') return;
          props.onReject({
            reason,
            note: note.trim() === '' ? undefined : note.trim(),
            shareNote,
            ...(blocking ? { neverIngest: scope } : {}),
          });
        }}
      >
        Reject
      </Button>
    </div>
  );
}
