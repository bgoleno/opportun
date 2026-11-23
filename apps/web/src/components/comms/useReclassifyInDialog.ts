import { useEffect, useRef } from 'react';
import { toast } from '@/components/ui/toast';
import { ApiError, errorMessage } from '@/lib/api';
import { useReclassify, type ReclassifyInput } from './api';

/** The message was rejected elsewhere: there is nothing left for the dialog to act on. */
const isRejected = (err: unknown): boolean =>
  err instanceof ApiError && err.code === 'message_rejected';

/**
 * A correction made from a row's dialog (#895). Its outcome is reported whether or not the row is
 * still there, since the list reloads first and can take the row and the dialog with it. A failure
 * is shown in the dialog (`error`) while it is open, and in a toast when it is gone, or when the
 * message is.
 */
export function useReclassifyInDialog(id: string, close: () => void) {
  const correction = useReclassify();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return {
    isPending: correction.isPending,
    error: correction.error,
    save: (input: ReclassifyInput, titles: { done: string; failed: string }) => {
      void correction.mutateAsync({ id, input }).then(
        () => {
          toast({ title: titles.done, variant: 'success' });
          close();
        },
        (err: unknown) => {
          if (mounted.current && !isRejected(err)) return;
          toast({ title: titles.failed, description: errorMessage(err), variant: 'destructive' });
          close();
        },
      );
    },
  };
}
