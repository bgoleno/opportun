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
 * is shown in the dialog (`error`) while it is open. It is a toast when the dialog is not: closed
 * while the request was out (#919), or gone with its row. And when the message is gone.
 */
export function useReclassifyInDialog(id: string, open: boolean, close: () => void) {
  const correction = useReclassify();
  // Whether the dialog is on screen when the request settles: read then, not when it started.
  const isOpen = useRef(open);
  isOpen.current = open;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const onScreen = () => mounted.current && isOpen.current;
  return {
    isPending: correction.isPending,
    error: correction.error,
    save: (input: ReclassifyInput, titles: { done: string; failed: string }) => {
      void correction.mutateAsync({ id, input }).then(
        () => {
          toast({ title: titles.done, variant: 'success' });
          // Only this dialog: a row shows one at a time, and another can be open by now.
          if (onScreen()) close();
        },
        (err: unknown) => {
          if (onScreen() && !isRejected(err)) return;
          toast({ title: titles.failed, description: errorMessage(err), variant: 'destructive' });
          if (onScreen()) close();
          // Said: not again in the dialog when it is next opened.
          correction.reset();
        },
      );
    },
  };
}
