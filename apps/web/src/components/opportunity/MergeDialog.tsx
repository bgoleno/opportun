// "Merge into..." (FR-O7): pick another opportunity with the inbox link picker's search, confirm
// which one survives, then merge this one into it and open the kept opportunity.
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useOpportunitySearch } from '@/components/comms/api';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import { ApiError, errorMessage } from '@/lib/api';
import { stageLabel, type OpportunityView } from '@/lib/opportunities';
import { useMergeOpportunity } from './api';

const label = (o: Pick<OpportunityView, 'title' | 'companyName'>): string =>
  `${o.title} at ${o.companyName}`;

function mergeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 422) return 'An opportunity cannot be merged into itself.';
    if (err.status === 404) return 'One of the opportunities no longer exists.';
  }
  return errorMessage(err);
}

export function MergeDialog(props: {
  /** The opportunity being merged away (the one whose page is open). */
  opp: OpportunityView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { opp } = props;
  const [q, setQ] = useState(opp.companyName);
  const [target, setTarget] = useState<OpportunityView | null>(null);
  const results = useOpportunitySearch(props.open ? q : '');
  const merge = useMergeOpportunity();
  const navigate = useNavigate();
  const candidates = results.data?.items.filter((o) => o.id !== opp.id) ?? [];

  function close(open: boolean) {
    if (!open) {
      setTarget(null);
      merge.reset();
    }
    props.onOpenChange(open);
  }

  async function confirm(keep: OpportunityView) {
    try {
      const kept = await merge.mutateAsync({ keepId: keep.id, otherId: opp.id });
      toast({ title: 'Opportunities merged', description: label(kept), variant: 'success' });
      close(false);
      await navigate({ to: '/opportunities/$id', params: { id: kept.id } });
    } catch (err) {
      toast({ title: 'Not merged', description: mergeError(err), variant: 'destructive' });
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={close}>
      <DialogContent className="max-w-lg">
        {target === null ? (
          <>
            <DialogHeader>
              <DialogTitle>Merge into another opportunity</DialogTitle>
              <DialogDescription>
                Pick the opportunity to keep. This one is merged into it.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor={`merge-search-${opp.id}`}>Search</Label>
              <Input
                id={`merge-search-${opp.id}`}
                value={q}
                autoComplete="off"
                onChange={(e) => setQ(e.currentTarget.value)}
              />
            </div>
            <ul className="grid max-h-72 gap-1 overflow-y-auto" aria-label="Matching opportunities">
              {q.trim().length === 0 ? (
                <li className="text-sm text-muted-foreground">Type to search.</li>
              ) : results.isPending ? (
                <li className="text-sm text-muted-foreground">Searching...</li>
              ) : results.isError ? (
                <li>
                  <FormError message={errorMessage(results.error)} />
                </li>
              ) : candidates.length === 0 ? (
                <li className="text-sm text-muted-foreground">No other matching opportunities.</li>
              ) : (
                candidates.map((o) => (
                  <li key={o.id}>
                    <button
                      type="button"
                      onClick={() => setTarget(o)}
                      className="grid w-full gap-0.5 rounded-md px-3 py-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="font-medium break-words">{label(o)}</span>
                      <span className="text-xs text-muted-foreground">{stageLabel(o.stage)}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
            <DialogFooter>
              <Button variant="ghost" onClick={() => close(false)}>
                Cancel
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Merge these opportunities?</DialogTitle>
              <DialogDescription>
                The activities, next steps, messages, resumes and files of the merged opportunity
                move to the kept one, which keeps the more advanced stage. This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <dl className="grid gap-2 text-sm">
              <div className="grid gap-0.5 rounded-md border p-3">
                <dt className="text-xs text-muted-foreground">Merged away (deleted)</dt>
                <dd className="font-medium break-words">{label(opp)}</dd>
              </div>
              <div className="grid gap-0.5 rounded-md border border-primary p-3">
                <dt className="text-xs text-muted-foreground">Kept</dt>
                <dd className="font-medium break-words">{label(target)}</dd>
              </div>
            </dl>
            <DialogFooter>
              <Button variant="outline" disabled={merge.isPending} onClick={() => setTarget(null)}>
                Back
              </Button>
              <Button
                variant="destructive"
                disabled={merge.isPending}
                onClick={() => void confirm(target)}
              >
                Merge
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
