import { useSortable } from '@dnd-kit/sortable';
import { Link } from '@tanstack/react-router';
import { X } from 'lucide-react';
import { CompanyLink } from '@/components/opportunity/CompanyLink';
import { postingNeedsReview } from '@/components/opportunity/PostingStateBanner';
import { StageMenu } from '@/components/stage/StageMenu';
import { subjectLabel, type StageFlow } from '@/components/stage/useStageFlow';
import { Badge } from '@/components/ui/badge';
import { IconButton } from '@/components/ui/icon-button';
import {
  formatDate,
  hasPossibleDuplicate,
  isTerminal,
  priorityLabel,
  sourceKindLabel,
  type OpportunityView,
} from '@/lib/opportunities';
import { cn } from '@/lib/utils';

export function KanbanCard(props: {
  opp: OpportunityView;
  selected: boolean;
  dueAt: number | undefined;
  flow: StageFlow;
  onSelect: (id: string) => void;
}) {
  const { opp, flow } = props;
  // useSortable (issue #240) registers the card both as a drag source and, within its
  // column's SortableContext, as a reorder target. The card still stays in place while
  // dragging either way (DragOverlay draws the moving copy): `transform`/`transition` are
  // deliberately unused, the same choice this already made for cross-column dragging.
  // `role: 'button'` from `attributes` is overridden back to `article` below: every existing
  // query for this card (and its own accessible name) depends on that role, not dnd-kit's.
  const { attributes, setNodeRef, listeners, isDragging } = useSortable({ id: opp.id });

  const label = subjectLabel(opp);
  return (
    <article
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      role="article"
      tabIndex={0}
      aria-label={label}
      aria-current={props.selected ? 'true' : undefined}
      data-opportunity-id={opp.id}
      onFocus={(e) => {
        if (e.target === e.currentTarget) props.onSelect(opp.id);
      }}
      className={cn(
        'relative grid cursor-grab touch-none gap-2 rounded-lg border bg-card p-3 text-card-foreground shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring',
        props.selected && 'border-primary ring-1 ring-primary',
        isDragging && 'border-dashed opacity-40',
      )}
    >
      <div className="grid gap-0.5 pr-6">
        <CompanyLink
          name={opp.companyName}
          domain={opp.companyDomain}
          className="text-xs text-muted-foreground"
        />
        <Link
          to="/opportunities/$id"
          params={{ id: opp.id }}
          tabIndex={-1}
          className="text-sm font-medium underline-offset-2 hover:underline"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {opp.title}
        </Link>
      </div>
      {!isTerminal(opp.stage) ? (
        // #138: this used to carry a title ("Dismiss <label>") richer than its aria-label
        // ("Dismiss"), itself a pre-existing drift the issue doesn't ask this sweep to fix.
        // Kept to the existing aria-label, now also the tooltip text, rather than changing
        // what the accessible name says.
        <IconButton
          variant="ghost"
          label="Dismiss"
          className="absolute top-1.5 right-1.5 size-7 text-muted-foreground"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => flow.dismiss(opp)}
        >
          <X className="size-4" aria-hidden="true" />
        </IconButton>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <StageMenu opp={opp} flow={flow} />
        {/* Quiet, always present (issue #201): where this one came from, not a judgment on
         *  it. Most of a real "New" column was never clicked into existence. */}
        <Badge variant="outline" title="Source">
          {sourceKindLabel(opp.sourceKind)}
        </Badge>
        {opp.priority === 1 ? <Badge variant="secondary">{priorityLabel(1)}</Badge> : null}
        {hasPossibleDuplicate(opp) ? (
          <Badge
            variant="outline"
            title="This looks like an opportunity you already track. Open it to merge or dismiss."
            className="border-amber-400 text-amber-700 dark:text-amber-300"
          >
            Possible duplicate
          </Badge>
        ) : null}
        {postingNeedsReview(opp) ? (
          <Badge
            variant="outline"
            title="The posting could not be confirmed on the company's job board."
            className="border-amber-400 text-amber-700 dark:text-amber-300"
          >
            Posting unconfirmed
          </Badge>
        ) : null}
        {props.dueAt !== undefined ? (
          <Badge variant="outline">Due {formatDate(props.dueAt)}</Badge>
        ) : null}
      </div>
    </article>
  );
}

/** What follows the pointer during a drag (rendered by DragOverlay, not interactive). */
export function CardPreview({ opp }: { opp: OpportunityView }) {
  return (
    <div
      aria-hidden="true"
      className="grid w-68 cursor-grabbing gap-1 rounded-lg border border-primary bg-card p-3 text-card-foreground shadow-lg"
    >
      <span className="text-xs text-muted-foreground">{opp.companyName}</span>
      <span className="text-sm font-medium">{opp.title}</span>
    </div>
  );
}
