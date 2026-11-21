import { useRef, useState } from 'react';
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
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';

/**
 * "Are you sure?" for destructive actions, and for any other that needs a yes first (say so with
 * confirmVariant, so it does not read as a warning). Closes only on success: a rejected `onConfirm`
 * leaves the dialog open with the failure shown in it, rather than closing as if it had
 * worked and leaving the outcome to a toast the person may not connect to this dialog. It can
 * always be left, even with the action in flight (a request has no time limit, so a dialog that
 * could not be left could trap the person: tl on #678); a failure that lands after it was left is
 * reported in a toast instead, so it is never shown nowhere (#678).
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
  // Whether the dialog is still open when the action settles: read then, not when it started.
  const open = useRef(props.open);
  open.current = props.open;
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
                if (open.current) setError(errorMessage(err));
                else {
                  toast({
                    title: `${props.confirmLabel} failed`,
                    description: errorMessage(err),
                    variant: 'destructive',
                  });
                }
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
