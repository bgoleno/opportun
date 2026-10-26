import type { OpportunityStage } from '@opportun/core';
import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { reopenTargets, stageLabel, stageTargets } from '@/lib/opportunities';
import { cn } from '@/lib/utils';
import { subjectLabel, type StageFlow, type StageSubject } from './useStageFlow';

/**
 * Keyboard-reachable stage changes for one opportunity: the valid targets from the state
 * machine, and (for closed or dismissed) a separate group of explicit Reopen actions.
 */
export function StageMenu(props: {
  opp: StageSubject;
  flow: Pick<StageFlow, 'request' | 'reopen'>;
  trigger?: ReactNode;
  className?: string;
}) {
  const { opp, flow } = props;
  const targets = stageTargets(opp.stage);
  const reopen = reopenTargets(opp.stage);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {props.trigger ?? (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Move ${subjectLabel(opp)}`}
            className={cn('h-7 gap-1 px-2 text-xs', props.className)}
            // Keep a click on the menu from starting a card drag.
            onPointerDown={(e) => e.stopPropagation()}
          >
            {stageLabel(opp.stage)}
            <ChevronDown className="size-3" aria-hidden="true" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Move to</DropdownMenuLabel>
        {targets.map((to: OpportunityStage) => (
          <DropdownMenuItem key={to} onSelect={() => flow.request(opp, to)}>
            {stageLabel(to)}
          </DropdownMenuItem>
        ))}
        {reopen.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Reopen</DropdownMenuLabel>
            {reopen.map((to) => (
              <DropdownMenuItem key={to} onSelect={() => flow.reopen(opp, to)}>
                Reopen as {stageLabel(to)}
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
