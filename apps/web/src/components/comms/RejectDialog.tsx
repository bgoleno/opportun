import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { senderAddress, useReject, type CommunicationView } from './api';
import { RejectForm } from './RejectForm';

/**
 * Reject as out of scope (spec D4). Distinct from Reclassify, which corrects what a message
 * IS; this says it should never have been here, and acts on that by deleting its content.
 */
export function RejectDialog(props: {
  comm: CommunicationView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const reject = useReject();
  const sender = senderAddress(props.comm.from);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reject this message</DialogTitle>
          <DialogDescription>
            It should never have been in Opportun. This is not the same as dismissing an opportunity
            you considered and turned down.
          </DialogDescription>
        </DialogHeader>
        <RejectForm
          sender={sender}
          pending={reject.isPending}
          onReject={(input) =>
            reject.mutate(
              { id: props.comm.id, input },
              {
                onSuccess: (result) => {
                  // "Removed" and "removed and blocked" are different promises; this message
                  // reports the one the server actually confirmed, not the one asked for (#145).
                  if (result.blocked === false) {
                    toast({
                      title: 'Rejected and removed, not blocked',
                      description: 'Mail from this sender may still be fetched again.',
                      variant: 'destructive',
                    });
                  } else {
                    toast({
                      title:
                        result.blocked === true
                          ? 'Rejected, removed, and blocked'
                          : 'Rejected and removed',
                      variant: 'success',
                    });
                  }
                  props.onOpenChange(false);
                },
                onError: (err) =>
                  toast({
                    title: 'Not rejected',
                    description: errorMessage(err),
                    variant: 'destructive',
                  }),
              },
            )
          }
        />
      </DialogContent>
    </Dialog>
  );
}
