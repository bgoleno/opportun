import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/toast';
import { useAcceptProposal, useDiscardProposal, usePromptVersions } from './api';
import { VersionDiff } from './promptEditor';

const TASK = 'comms.classify';

/**
 * A refinement of the inbox classifier proposed from the user's corrections. Shown with a diff
 * against the active prompt; nothing changes until the user accepts it.
 */
export function ProposedRefinement() {
  const versions = usePromptVersions(TASK);
  const accept = useAcceptProposal(TASK);
  const discard = useDiscardProposal(TASK);
  const list = versions.data ?? [];
  const proposal = list.find((v) => v.proposed && !v.isActive);
  const active = list.find((v) => v.isActive);
  if (proposal === undefined || active === undefined) return null;
  const busy = accept.isPending || discard.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4" aria-hidden="true" />
          Proposed refinement
        </CardTitle>
        <CardDescription>
          From your recent inbox corrections, a revised classification prompt is suggested. It is
          not in use until you accept it.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {proposal.proposalSummary ? (
          <p className="text-sm">
            <span className="font-medium">What changed: </span>
            {proposal.proposalSummary}
          </p>
        ) : null}
        <VersionDiff before={active} after={proposal} />
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy}
            onClick={() =>
              accept.mutate(proposal.id, {
                onSuccess: () =>
                  toast({
                    title: 'Refinement accepted',
                    description: `Version ${proposal.version} now classifies your inbox.`,
                    variant: 'success',
                  }),
              })
            }
          >
            Accept
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              discard.mutate(proposal.id, {
                onSuccess: () => toast({ title: 'Proposal discarded' }),
              })
            }
          >
            Discard
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
