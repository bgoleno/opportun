import { ChevronDown, RotateCcw } from 'lucide-react';
import type { StageFlow } from '@/components/stage/useStageFlow';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  closedReasonLabel,
  dismissReasonLabel,
  reopenTargets,
  stageLabel,
  stageTargets,
  type OpportunityView,
} from '@/lib/opportunities';

/**
 * Stage dropdown limited to the state machine's valid targets (closed and dismissed open
 * their reason dialogs through the flow). Moving out of closed or dismissed is a separate,
 * explicit Reopen action; the stage dropdown never reopens.
 */
export function StageControl({ opp, flow }: { opp: OpportunityView; flow: StageFlow }) {
  const stage = flow.overrides.get(opp.id) ?? opp.stage;
  const subject = { ...opp, stage };
  const targets = stageTargets(stage);
  const reopen = reopenTargets(stage);
  const label = `Stage: ${stageLabel(stage)}`;
  const reason =
    stage === 'closed' && opp.closedReason
      ? closedReasonLabel(opp.closedReason)
      : stage === 'dismissed' && opp.dismissedReason
        ? dismissReasonLabel(opp.dismissedReason)
        : null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" disabled={targets.length === 0}>
            {label}
            <ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {targets.map((to) => (
            <DropdownMenuItem key={to} onSelect={() => flow.request(subject, to)}>
              {stageLabel(to)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {reason !== null ? <Badge variant="secondary">{reason}</Badge> : null}
      {reopen.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary">
              <RotateCcw aria-hidden="true" />
              Reopen
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {reopen.map((to) => (
              <DropdownMenuItem key={to} onSelect={() => flow.reopen(subject, to)}>
                {stageLabel(to)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
