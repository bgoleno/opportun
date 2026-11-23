import { COMM_CLASSIFICATIONS, OUTREACH_KINDS, type CommClassification } from '@opportun/core';
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
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { errorMessage } from '@/lib/api';
import { classificationLabel, outreachLabel, type CommunicationView } from './api';
import { useReclassifyInDialog } from './useReclassifyInDialog';

/** Corrects the classification. Each correction is kept to improve the classifier. */
export function ReclassifyDialog(props: {
  comm: CommunicationView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { comm } = props;
  const [classification, setClassification] = useState<CommClassification>(
    comm.classification ?? 'other',
  );
  const [outreach, setOutreach] = useState<string>(comm.outreachKind ?? 'targeted');
  const correction = useReclassifyInDialog(comm.id, () => props.onOpenChange(false));
  const isOutreach = classification === 'solicitation';

  function submit() {
    const outreachKind = isOutreach
      ? (OUTREACH_KINDS.find((k) => k === outreach) ?? 'targeted')
      : null;
    correction.save(
      { classification, outreachKind },
      { done: 'Classification saved', failed: 'Classification not saved' },
    );
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reclassify message</DialogTitle>
          <DialogDescription>
            Your corrections are saved and used to suggest improvements to the classifier, which you
            review before anything changes.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor={`reclassify-kind-${comm.id}`}>Type</Label>
            <Select
              id={`reclassify-kind-${comm.id}`}
              value={classification}
              onChange={(e) => {
                const next = COMM_CLASSIFICATIONS.find((c) => c === e.currentTarget.value);
                if (next) setClassification(next);
              }}
            >
              {COMM_CLASSIFICATIONS.map((c) => (
                <option key={c} value={c}>
                  {classificationLabel(c)}
                </option>
              ))}
            </Select>
          </div>
          {isOutreach ? (
            <div className="grid gap-2">
              <Label htmlFor={`reclassify-outreach-${comm.id}`}>Outreach</Label>
              <Select
                id={`reclassify-outreach-${comm.id}`}
                value={outreach}
                onChange={(e) => setOutreach(e.currentTarget.value)}
              >
                {OUTREACH_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {outreachLabel(k)}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          {correction.error ? <FormError message={errorMessage(correction.error)} /> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={correction.isPending} onClick={submit}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
