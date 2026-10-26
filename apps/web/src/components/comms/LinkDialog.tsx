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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { stageLabel } from '@/lib/opportunities';
import { useOpportunitySearch, useReclassify, type CommunicationView } from './api';

/** Search the caller's opportunities and link (or unlink) the message. */
export function LinkDialog(props: {
  comm: CommunicationView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { comm } = props;
  const [q, setQ] = useState(comm.companyName ?? '');
  const results = useOpportunitySearch(props.open ? q : '');
  const relink = useReclassify();

  function link(opportunityId: string | null) {
    relink.mutate(
      { id: comm.id, input: { opportunityId } },
      {
        onSuccess: () => {
          toast({
            title: opportunityId ? 'Message linked' : 'Message unlinked',
            variant: 'success',
          });
          props.onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Link to an opportunity</DialogTitle>
          <DialogDescription>Search by company or title.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor={`link-search-${comm.id}`}>Search</Label>
          <Input
            id={`link-search-${comm.id}`}
            value={q}
            autoComplete="off"
            onChange={(e) => setQ(e.currentTarget.value)}
          />
        </div>
        {relink.error ? <FormError message={errorMessage(relink.error)} /> : null}
        <ul className="grid max-h-72 gap-1 overflow-y-auto" aria-label="Matching opportunities">
          {q.trim().length === 0 ? (
            <li className="text-sm text-muted-foreground">Type to search.</li>
          ) : results.isPending ? (
            <li className="text-sm text-muted-foreground">Searching...</li>
          ) : results.isError ? (
            <li>
              <FormError message={errorMessage(results.error)} />
            </li>
          ) : results.data.items.length === 0 ? (
            <li className="text-sm text-muted-foreground">No matching opportunities.</li>
          ) : (
            results.data.items.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  disabled={relink.isPending}
                  onClick={() => link(o.id)}
                  className="grid w-full gap-0.5 rounded-md px-3 py-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="font-medium">
                    {o.title} at {o.companyName}
                  </span>
                  <span className="text-xs text-muted-foreground">{stageLabel(o.stage)}</span>
                </button>
              </li>
            ))
          )}
        </ul>
        <DialogFooter>
          {comm.opportunityId ? (
            <Button variant="outline" disabled={relink.isPending} onClick={() => link(null)}>
              Unlink
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
