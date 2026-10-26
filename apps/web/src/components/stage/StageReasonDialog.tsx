import { zodResolver } from '@hookform/resolvers/zod';
import {
  CLOSED_REASONS,
  DISMISS_REASONS,
  type ClosedReason,
  type DismissReason,
} from '@opportun/core';
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
import { closedReasonLabel, dismissReasonLabel } from '@/lib/opportunities';

export type ReasonKind = 'closed' | 'dismissed';

export type ReasonResult =
  | { kind: 'closed'; reason: ClosedReason; note?: string }
  | { kind: 'dismissed'; reason: DismissReason; note?: string };

const COPY = {
  closed: {
    title: 'Close opportunity',
    description: 'Record how this one ended. Closed opportunities leave the active pipeline.',
    confirm: 'Close opportunity',
  },
  dismissed: {
    title: 'Dismiss opportunity',
    description: 'Say why it is not a fit. Reasons help tune discovery.',
    confirm: 'Dismiss',
  },
} as const;

const FormSchema = z.object({
  reason: z.string().min(1, 'Choose a reason'),
  note: z.string().trim().max(2000, 'Use at most 2000 characters'),
});
type FormValues = z.infer<typeof FormSchema>;

/**
 * Reason (required) plus an optional note, for moving to closed or dismissed. Nothing is
 * sent until the user confirms; cancelling leaves the opportunity where it was.
 */
export function StageReasonDialog(props: {
  kind: ReasonKind | null;
  subject: string;
  /** True while a previous confirm is still in flight: disables the confirm button so the
   *  request cannot be sent twice (the dialog now stays open until it settles, see #124). */
  pending?: boolean;
  onCancel: () => void;
  onConfirm: (result: ReasonResult) => void;
}) {
  const kind = props.kind ?? 'dismissed';
  const copy = kind === 'closed' ? COPY.closed : COPY.dismissed;
  const reasons =
    kind === 'closed'
      ? CLOSED_REASONS.map((r) => [r, closedReasonLabel(r)] as const)
      : // denied_company (#199) is assigned only by the system, when discovery auto-suppresses
        // a posting at ingest time -- an opportunity reaching this dialog was never such a
        // suppression (it exists at all, so it was created, imported or accepted), so offering
        // it here would be a choice with no situation it could ever correctly describe.
        DISMISS_REASONS.filter((r) => r !== 'denied_company').map(
          (r) => [r, dismissReasonLabel(r)] as const,
        );

  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: { reason: '', note: '' },
  });
  const { errors } = form.formState;

  function close() {
    form.reset();
    props.onCancel();
  }

  const submit = form.handleSubmit((v) => {
    const note = v.note.length > 0 ? { note: v.note } : {};
    const result =
      kind === 'closed'
        ? { kind, reason: v.reason as ClosedReason, ...note }
        : { kind, reason: v.reason as DismissReason, ...note };
    form.reset();
    props.onConfirm(result);
  });

  return (
    <Dialog
      open={props.kind !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{props.subject}</span>. {copy.description}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" noValidate onSubmit={submit}>
          <FormField label="Reason" error={errors.reason?.message}>
            {(control) => (
              <Select {...control} {...form.register('reason')}>
                <option value="">Choose...</option>
                {reasons.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
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
            <Button
              type="submit"
              variant={kind === 'dismissed' ? 'destructive' : 'default'}
              disabled={props.pending}
            >
              {copy.confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
