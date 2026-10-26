import type { OpportunityStage } from '@opportun/core';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { stageLabel } from '@/lib/opportunities';

/** Accepting a proposal on a closed or dismissed opportunity reopens it: the user says so. */
export function ReopenDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  from: OpportunityStage;
  to: OpportunityStage;
  title: string;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reopen {props.title}?</DialogTitle>
          <DialogDescription>
            It is {stageLabel(props.from)}. Accepting the suggestion reopens it and moves it to{' '}
            {stageLabel(props.to)}. The stage history records the reopen.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              props.onConfirm();
              props.onOpenChange(false);
            }}
          >
            Reopen and move to {stageLabel(props.to)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
