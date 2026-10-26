// Dialogs for the review queue: dismiss with a reason, the duplicate-accept choice, and the
// full posting. Posting fields are rendered as text only (third-party data).
import { zodResolver } from '@hookform/resolvers/zod';
import { DISMISS_REASONS, type DismissReason } from '@opportun/core';
import { Link } from '@tanstack/react-router';
import { ExternalLink } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { OpenOriginal } from '@/components/comms/OpenOriginal';
import { Badge } from '@/components/ui/badge';
import { dismissReasonLabel, formatDateTime, safeHttpUrl } from '@/lib/opportunities';
import { sourceKindLabel, type BulkProgress, type DiscoveryResult } from './api';

/** "Accepting…" while the first chunk is in flight, "Accepting 100/150…" once a chunked
 *  batch's progress callback has fired at least once (#184). */
function busyLabel(verb: string, progress: BulkProgress | null): string {
  return progress === null ? `${verb}…` : `${verb} ${progress.done}/${progress.total}…`;
}
import { ResolutionChip, resultLabel, ScoreBadge } from './QueueRow';

/** Reasons a person reviewing one posting can pick for themselves. `denied_company` (#199) is
 *  assigned only by the system, when a posting's company matched the user's own denylist at
 *  ingest time -- a posting that reached this dialog was never such a match, so offering it
 *  here would be a choice with no situation it could ever correctly describe. */
const MANUAL_DISMISS_REASONS = DISMISS_REASONS.filter((r) => r !== 'denied_company');

const DismissSchema = z.object({
  reason: z.enum(DISMISS_REASONS, { error: 'Choose a reason' }),
  note: z.string().trim().max(2000, 'Use at most 2000 characters'),
});
type DismissInput = z.input<typeof DismissSchema>;
type DismissOutput = z.output<typeof DismissSchema>;

/** Reason (required: it tunes discovery) plus an optional note. Nothing is sent until confirm.
 *  `otherLocations` (issue #191) names a dismiss that covers a whole location group, so the
 *  person confirming it knows it is more than the one row shown -- the same reason is recorded
 *  for every location, since "not a fit" or "wrong seniority" is a judgment about the role, not
 *  about which office posted it. */
export function DismissResultDialog(props: {
  result: DiscoveryResult | null;
  otherLocations?: number;
  onCancel: () => void;
  onConfirm: (v: { reason: DismissReason; note?: string }) => void;
}) {
  const form = useForm<DismissInput, unknown, DismissOutput>({
    resolver: zodResolver(DismissSchema),
    defaultValues: { reason: '' as DismissReason, note: '' },
  });
  const { errors } = form.formState;

  function close() {
    form.reset();
    props.onCancel();
  }

  const submit = form.handleSubmit((v) => {
    form.reset();
    props.onConfirm({ reason: v.reason, ...(v.note.length > 0 ? { note: v.note } : {}) });
  });

  return (
    <Dialog
      open={props.result !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Dismiss result</DialogTitle>
          <DialogDescription>
            <span className="font-medium break-words text-foreground">
              {props.result === null ? '' : resultLabel(props.result)}
            </span>
            {props.otherLocations !== undefined && props.otherLocations > 0
              ? ` and ${props.otherLocations} other ${props.otherLocations === 1 ? 'location' : 'locations'} for this role`
              : ''}
            . Say why it is not a fit. Reasons help tune discovery.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" noValidate onSubmit={submit}>
          <FormField label="Reason" error={errors.reason?.message}>
            {(control) => (
              <Select {...control} {...form.register('reason')}>
                <option value="">Choose...</option>
                {MANUAL_DISMISS_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {dismissReasonLabel(r)}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="Note (optional)" error={errors.note?.message}>
            {(control) => <Textarea rows={3} {...control} {...form.register('note')} />}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive">
              Dismiss
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const BulkDismissSchema = z.object({
  reason: z.enum(DISMISS_REASONS, { error: 'Choose a reason' }),
  note: z.string().trim().max(2000, 'Use at most 2000 characters'),
});
type BulkDismissInput = z.input<typeof BulkDismissSchema>;
type BulkDismissOutput = z.output<typeof BulkDismissSchema>;

/**
 * One reason for the whole batch, not a per-item prompt (#184): triaging dozens of results one
 * dialog at a time would defeat the point of bulk dismiss. Defaults to `not_interested`, the
 * common case, but the owner also hits a batch of true duplicates dedupe missed (#191) and picks
 * `duplicate` for those instead, so the picker stays open rather than hard-coding one reason.
 */
export function BulkDismissDialog(props: {
  open: boolean;
  count: number;
  busy: boolean;
  progress: BulkProgress | null;
  onCancel: () => void;
  onConfirm: (v: { reason: DismissReason; note?: string }) => void;
}) {
  const form = useForm<BulkDismissInput, unknown, BulkDismissOutput>({
    resolver: zodResolver(BulkDismissSchema),
    defaultValues: { reason: 'not_interested', note: '' },
  });
  const { errors } = form.formState;

  function close() {
    form.reset();
    props.onCancel();
  }

  const submit = form.handleSubmit((v) => {
    form.reset();
    props.onConfirm({ reason: v.reason, ...(v.note.length > 0 ? { note: v.note } : {}) });
  });

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Dismiss {props.count} results</DialogTitle>
          <DialogDescription>
            One reason for the whole batch. Reasons help tune discovery.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" noValidate onSubmit={submit}>
          <FormField label="Reason" error={errors.reason?.message}>
            {(control) => (
              <Select {...control} {...form.register('reason')}>
                {DISMISS_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {dismissReasonLabel(r)}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="Note (optional)" error={errors.note?.message}>
            {(control) => <Textarea rows={3} {...control} {...form.register('note')} />}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={props.busy}>
              {props.busy ? busyLabel('Dismissing', props.progress) : `Dismiss ${props.count}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Bulk accept creates one opportunity per selected result right away, unlike bulk dismiss
 *  there is no single undo for the whole batch (#184): each would need undoing on its own,
 *  the same as any other opportunity, so the dialog says so before it happens. */
export function BulkAcceptConfirmDialog(props: {
  open: boolean;
  count: number;
  busy: boolean;
  progress: BulkProgress | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onCancel();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Accept {props.count} results?</DialogTitle>
          <DialogDescription>
            This creates {props.count} new opportunities in your pipeline right away. There is no
            batch undo: a duplicate match in the selection is reported, not created, but anything
            created is created for good, the same as accepting one at a time.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button type="button" disabled={props.busy} onClick={props.onConfirm}>
            {props.busy ? busyLabel('Accepting', props.progress) : `Accept ${props.count}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface DuplicateState {
  result: DiscoveryResult;
  existingId: string;
}

/**
 * Accepting matched an opportunity already tracked (409 duplicate). Same pattern as the new
 * opportunity dialog (view the existing one, or create anyway), plus "Attach to existing",
 * which links this result to that opportunity instead of creating another.
 */
export function DuplicateAcceptDialog(props: {
  state: DuplicateState | null;
  busy: boolean;
  onCancel: () => void;
  onAttach: (s: DuplicateState) => void;
  onForce: (s: DuplicateState) => void;
}) {
  const s = props.state;
  return (
    <Dialog
      open={s !== null}
      onOpenChange={(open) => {
        if (!open) props.onCancel();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Already in your pipeline?</DialogTitle>
          <DialogDescription>
            <span className="font-medium break-words text-foreground">
              {s === null ? '' : resultLabel(s.result)}
            </span>{' '}
            looks like an opportunity you already track.
          </DialogDescription>
        </DialogHeader>
        {s !== null ? (
          <div
            role="alert"
            className="grid gap-2 rounded-md border border-primary/40 bg-accent px-3 py-2 text-sm text-accent-foreground"
          >
            <p>Attach this posting to it as another source, or create a separate opportunity.</p>
            <Link
              to="/opportunities/$id"
              params={{ id: s.existingId }}
              className="w-fit font-medium underline underline-offset-2"
            >
              View the existing opportunity
            </Link>
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={props.busy}
            onClick={() => {
              if (s !== null) props.onForce(s);
            }}
          >
            Create anyway
          </Button>
          <Button
            type="button"
            disabled={props.busy}
            onClick={() => {
              if (s !== null) props.onAttach(s);
            }}
          >
            Attach to existing
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The whole posting, as plain text, with accept and dismiss. */
export function ResultDetailDialog(props: {
  result: DiscoveryResult | null;
  onClose: () => void;
  onAccept: (r: DiscoveryResult) => void;
  onDismiss: (r: DiscoveryResult) => void;
  /** Opens the capture dialog for a needs_capture lead (pre-filled with its link). */
  onCapture: (r: DiscoveryResult) => void;
}) {
  const r = props.result;
  const p = r?.posting;
  const href = safeHttpUrl(p?.postingUrl);
  return (
    <Dialog
      open={r !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="break-words">{p?.title ?? ''}</DialogTitle>
          <DialogDescription className="break-words">
            {p?.company ?? ''}
            {p?.location ? ` · ${p.location}` : ''}
          </DialogDescription>
        </DialogHeader>
        {r !== null && p !== undefined ? (
          <div className="grid gap-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <ScoreBadge score={r.aiScore} />
              <ResolutionChip resolution={r.resolution} />
              {p.remote === true ? <Badge variant="outline">Remote</Badge> : null}
              <span className="text-muted-foreground">
                From {sourceKindLabel(r.sourceKind)}, found {formatDateTime(r.createdAt)}
              </span>
              {/*
                The mail this lead was parsed out of (design D3b). The failure Brian named was
                having to go and search his own mailbox to understand a row, so the dialog is
                self-sufficient and this link is for the one thing it cannot hold: the message.
              */}
              {r.sourceMailChannel !== null && r.sourceMailExternalId !== null ? (
                <OpenOriginal
                  comm={{ channel: r.sourceMailChannel, externalId: r.sourceMailExternalId }}
                  label="View the source email"
                  explain
                />
              ) : null}
            </div>
            {r.aiRationale ? (
              <p className="break-words">
                <span className="text-muted-foreground">Why: </span>
                {r.aiRationale}
              </p>
            ) : null}
            {p.compNote ? <p className="break-words">{p.compNote}</p> : null}
            {r.resolution === 'needs_capture' || r.resolution === 'capture_failed' ? (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-muted-foreground">
                  {r.resolution === 'capture_failed'
                    ? 'Only a partial lead was found, and automatic capture gave up after repeated tries. Capture the full description by hand to complete it.'
                    : 'Only a partial lead was found. Capture the full description to complete it.'}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => props.onCapture(r)}
                >
                  Capture description
                </Button>
              </div>
            ) : null}
            {p.descriptionMd ? (
              <div className="max-h-[50vh] overflow-y-auto rounded-md border bg-muted/30 p-3">
                <p className="break-words whitespace-pre-wrap">{p.descriptionMd}</p>
              </div>
            ) : (
              <p className="text-muted-foreground">No description.</p>
            )}
            {href !== null ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="inline-flex w-fit items-center gap-1 text-primary underline underline-offset-2"
              >
                Open the posting
                <ExternalLink aria-hidden="true" className="size-3.5" />
              </a>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              if (r !== null) props.onDismiss(r);
            }}
          >
            Dismiss
          </Button>
          <Button
            type="button"
            onClick={() => {
              if (r !== null) props.onAccept(r);
            }}
          >
            Accept
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
