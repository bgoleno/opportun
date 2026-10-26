// Possible-duplicate flag (#9): a forced create, or a discovery-accept override, already
// records which other opportunity this one might be. This surfaces that, the same way
// PostingStateBanner surfaces board reconciliation, with "Merge" (reusing the same merge the
// "..." menu offers, just pre-targeted) and "Not a duplicate" (persisted, not client-only).
import { Link, useNavigate } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { ApiError, errorMessage } from '@/lib/api';
import type { OpportunityView } from '@/lib/opportunities';
import { useDismissPossibleDuplicate, useMergeOpportunity, useOpportunity } from './api';

function mergeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 422) return 'An opportunity cannot be merged into itself.';
    if (err.status === 404) return 'One of the opportunities no longer exists.';
  }
  return errorMessage(err);
}

function PossibleDuplicateRow(props: { opp: OpportunityView; otherId: string }) {
  const { opp, otherId } = props;
  const { data: other, error } = useOpportunity(otherId);
  const [confirming, setConfirming] = useState(false);
  const merge = useMergeOpportunity();
  const dismiss = useDismissPossibleDuplicate(opp.id);
  const navigate = useNavigate();

  // A stale flag (the other side was already resolved elsewhere): say nothing rather than
  // link to a row that is gone. A refetch of this opportunity clears possibleDuplicates.
  if (error || other === undefined) return null;

  const label = `${other.title} at ${other.companyName}`;

  async function confirmMerge() {
    try {
      const kept = await merge.mutateAsync({ keepId: otherId, otherId: opp.id });
      toast({ title: 'Opportunities merged', description: label, variant: 'success' });
      await navigate({ to: '/opportunities/$id', params: { id: kept.id } });
    } catch (err) {
      toast({ title: 'Not merged', description: mergeError(err), variant: 'destructive' });
    }
  }

  function notADuplicate() {
    dismiss.mutate(otherId, {
      onError: (err) =>
        toast({ title: 'Not dismissed', description: errorMessage(err), variant: 'destructive' }),
    });
  }

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
      <span className="flex-1">
        Possible duplicate: you already track{' '}
        <Link
          to="/opportunities/$id"
          params={{ id: otherId }}
          className="font-medium underline underline-offset-2"
        >
          {label}
        </Link>
        .
      </span>
      {confirming ? (
        <div className="flex items-center gap-2">
          <span>This cannot be undone.</span>
          <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={merge.isPending}
            onClick={() => void confirmMerge()}
          >
            Merge this opportunity in
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(true)}>
            Merge
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={dismiss.isPending}
            onClick={notADuplicate}
          >
            Not a duplicate
          </Button>
        </div>
      )}
    </div>
  );
}

export function PossibleDuplicateBanner(props: { opp: OpportunityView }) {
  if (props.opp.possibleDuplicates.length === 0) return null;
  return (
    <div className="grid gap-2">
      {props.opp.possibleDuplicates.map((otherId) => (
        <PossibleDuplicateRow key={otherId} opp={props.opp} otherId={otherId} />
      ))}
    </div>
  );
}
