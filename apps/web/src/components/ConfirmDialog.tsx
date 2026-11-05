import { useState } from 'react';
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
import { errorMessage } from '@/lib/api';

/**
 * "Are you sure?" for destructive actions, and for any other that needs a yes first (say so with
 * confirmVariant, so it does not read as a warning). Closes only on success: a rejected `onConfirm`
 * leaves the dialog open with the failure shown in it, rather than closing as if it had
 * worked and leaving the outcome to a toast the person may not connect to this dialog.
 */
export function ConfirmDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  confirmVariant?: 'default' | 'destructive';
  onConfirm: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open={props.open}
      onOpenChange={(o) => {
        if (!o) setError(null);
        props.onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        {error === null ? null : <FormError message={error} />}
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={props.confirmVariant ?? 'destructive'}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await props.onConfirm();
                props.onOpenChange(false);
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {props.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
