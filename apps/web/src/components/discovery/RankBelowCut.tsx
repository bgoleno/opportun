// Rank these (https://github.com/bgoleno/opportun/issues/215, #190 N1b): a board's first run ranks
// at most 25 postings. The rest wait below the cut, and go through the discovery budget only once
// the user has seen how many there are and what they should cost.
import { useState } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useRankBelowCut } from './api';
import { usd, whole } from './costFigures';

const postings = (n: number): string => `${whole.format(n)} ${n === 1 ? 'posting' : 'postings'}`;

function estimate(costUsd: number | null, avgCostUsd: number | null): string {
  // No ranking calls in the last 30 days to go by: not a cost of nothing.
  if (costUsd === null || avgCostUsd === null) {
    return 'Estimated cost: not known yet, because nothing was ranked in the last 30 days.';
  }
  return `Estimated cost: ${usd.format(costUsd)}, at the last 30 days' average of ${usd.format(avgCostUsd)} a call.`;
}

export function RankBelowCut(props: {
  sourceId: string;
  /** Tells this button from the same button on another source's row. */
  sourceName: string;
  count: number;
  costUsd: number | null;
  avgCostUsd: number | null;
}) {
  const [open, setOpen] = useState(false);
  const rank = useRankBelowCut();
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">
        {whole.format(props.count)} not ranked: below the cut
      </span>
      <Button
        size="sm"
        variant="outline"
        aria-label={`Rank these: ${postings(props.count)} from ${props.sourceName}`}
        onClick={() => setOpen(true)}
      >
        Rank these
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Rank ${postings(props.count)}?`}
        description={`${estimate(props.costUsd, props.avgCostUsd)} They go through your discovery budget, so any that do not fit today wait for a later budget day.`}
        confirmLabel={`Rank ${postings(props.count)}`}
        confirmVariant="default"
        onConfirm={async () => {
          const { queued } = await rank.mutateAsync({ id: props.sourceId, count: props.count });
          toast({ title: `${postings(queued)} queued for ranking`, variant: 'success' });
        }}
      />
    </div>
  );
}
