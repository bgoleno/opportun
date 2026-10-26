import {
  DndContext,
  DragOverlay,
  KeyboardCode,
  KeyboardSensor,
  pointerWithin,
  rectIntersection,
  type CollisionDetection,
  type KeyboardCodes,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { OPPORTUNITY_STAGES, type OpportunityStage } from '@opportun/core';
import { ChevronsLeftRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from '@/components/ui/toast';
import { subjectLabel, type StageFlow } from '@/components/stage/useStageFlow';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { isTerminal, stageLabel, type OpportunityView } from '@/lib/opportunities';
import { cn } from '@/lib/utils';
import { reorderColumn } from './reorder';
import { CardPreview, KanbanCard } from './KanbanCard';

const START_WITH_SPACE_ONLY: KeyboardCodes = {
  start: [KeyboardCode.Space],
  cancel: [KeyboardCode.Esc],
  end: [KeyboardCode.Space, KeyboardCode.Enter],
};

export interface BoardColumn {
  stage: OpportunityStage;
  items: OpportunityView[];
  collapsed: boolean;
}

function Column(props: {
  column: BoardColumn;
  onToggle: (stage: OpportunityStage) => void;
  children: ReactNode;
}) {
  const { stage, items, collapsed } = props.column;
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  const name = stageLabel(stage);
  return (
    <section
      ref={setNodeRef}
      aria-label={`${name} column`}
      className={cn(
        'flex shrink-0 flex-col gap-2 rounded-xl border bg-muted/60 p-2 transition-colors',
        collapsed ? 'w-14 items-center' : 'w-72',
        isOver && 'border-primary bg-accent',
      )}
    >
      {collapsed ? (
        <button
          type="button"
          aria-label={`Expand ${name} (${items.length})`}
          aria-expanded="false"
          onClick={() => props.onToggle(stage)}
          className="flex flex-1 cursor-pointer flex-col items-center gap-2 rounded-md py-2 text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronsLeftRight className="size-4" aria-hidden="true" />
          <span className="[writing-mode:vertical-rl]">{name}</span>
          <span className="tabular-nums">{items.length}</span>
        </button>
      ) : (
        <>
          <header className="flex items-center justify-between px-1 pt-1">
            <h2 className="text-sm font-semibold">
              {name}{' '}
              <span className="font-normal text-muted-foreground tabular-nums">{items.length}</span>
            </h2>
            {/* #138: a raw <button>, not the Button component, so it is wrapped directly
                rather than through IconButton, which would pull in Button's own sizing. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`Collapse ${name}`}
                  aria-expanded="true"
                  onClick={() => props.onToggle(stage)}
                  className="cursor-pointer rounded-sm p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronsLeftRight className="size-4" aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Collapse {name}</TooltipContent>
            </Tooltip>
          </header>
          <div className="flex min-h-24 flex-col gap-2">{props.children}</div>
        </>
      )}
    </section>
  );
}

/**
 * The column under the pointer wins; the dragged card's rectangle is only a fallback.
 * Rectangle overlap alone favours wide neighbours over the narrow collapsed columns.
 */
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : rectIntersection(args);
};

/**
 * Columns are stages; a card dropped on a column (or on another card in a different column)
 * asks the stage flow to move it. A card dropped on another card in its OWN column reorders
 * within it instead (issue #240) -- disabled while a text filter can be hiding siblings that
 * would otherwise get a say in where it lands (reorderDisabled).
 */
export function Kanban(props: {
  columns: BoardColumn[];
  flow: StageFlow;
  selectedId: string | null;
  nextDue: ReadonlyMap<string, number>;
  onSelect: (id: string) => void;
  onToggleColumn: (stage: OpportunityStage) => void;
  onReorder: (changes: { id: string; sortOrder: number }[]) => void;
  reorderDisabled: boolean;
  stageOf: (opp: OpportunityView) => OpportunityStage;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // Space only to pick up (issue #240): the default also starts a drag on Enter, which
    // collides with this app's own Enter-opens-the-selected-card convention (useHotkeys
    // below, and every other screen in ShortcutsOverlay) for a card that merely has focus.
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: START_WITH_SPACE_ONLY,
    }),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const byId = new Map(props.columns.flatMap((c) => c.items.map((o) => [o.id, o] as const)));
  const active = activeId === null ? undefined : byId.get(activeId);

  const nameOf = (id: string | number) => {
    const opp = byId.get(String(id));
    return opp ? subjectLabel(opp) : 'Opportunity';
  };
  /** A drop target is either a column itself or another card; either way, name its column. */
  const columnOf = (id: string | number | undefined) => {
    const stage = OPPORTUNITY_STAGES.find((s) => s === id);
    const resolved = stage ?? (id === undefined ? undefined : props.stageOf(byId.get(String(id))!));
    return resolved ? `the ${stageLabel(resolved)} column` : 'no column';
  };
  const announcements: Announcements = {
    onDragStart: ({ active: a }) => `Picked up ${nameOf(a.id)}.`,
    onDragOver: ({ active: a, over }) => `${nameOf(a.id)} is over ${columnOf(over?.id)}.`,
    onDragEnd: ({ active: a, over }) => `${nameOf(a.id)} was dropped on ${columnOf(over?.id)}.`,
    onDragCancel: ({ active: a }) => `Moving ${nameOf(a.id)} was cancelled.`,
  };

  function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const opp = byId.get(String(e.active.id));
    if (opp === undefined || e.over === null) return;
    const overId = String(e.over.id);
    const fromStage = props.stageOf(opp);
    const targetStage = OPPORTUNITY_STAGES.find((s) => s === overId);
    if (targetStage !== undefined) {
      // Dropped on the column itself (an empty column, or outside any card): cross-stage move.
      if (targetStage !== fromStage) props.flow.request({ ...opp, stage: fromStage }, targetStage);
      return;
    }
    const overOpp = byId.get(overId);
    if (overOpp === undefined) return;
    const toStage = props.stageOf(overOpp);
    if (toStage !== fromStage) {
      // Dropped on a card in a different column: still a stage move, not a rank within it --
      // the destination appends it at the bottom server-side regardless of drop position.
      props.flow.request({ ...opp, stage: fromStage }, toStage);
      return;
    }
    if (props.reorderDisabled) {
      toast({
        title: 'Reordering is off while filtering',
        description: 'Clear the search to drag cards within a column.',
      });
      return;
    }
    const column = props.columns.find((c) => c.stage === fromStage);
    if (column === undefined) return;
    const ids = column.items.map((o) => o.id);
    const fromIndex = ids.indexOf(opp.id);
    const toIndex = ids.indexOf(overOpp.id);
    if (fromIndex === -1 || toIndex === -1) return;
    const currentSortOrder = new Map(column.items.map((o) => [o.id, o.sortOrder] as const));
    const changes = reorderColumn(ids, fromIndex, toIndex, currentSortOrder);
    if (changes.length > 0) props.onReorder(changes);
  }

  const renderColumn = (column: BoardColumn) => (
    <Column key={column.stage} column={column} onToggle={props.onToggleColumn}>
      <SortableContext items={column.items.map((o) => o.id)} strategy={verticalListSortingStrategy}>
        {column.items.map((opp) => (
          <KanbanCard
            key={opp.id}
            opp={{ ...opp, stage: column.stage }}
            selected={props.selectedId === opp.id}
            dueAt={props.nextDue.get(opp.id)}
            flow={props.flow}
            onSelect={props.onSelect}
          />
        ))}
      </SortableContext>
      {column.items.length === 0 ? (
        <p className="px-1 py-4 text-center text-xs text-muted-foreground">Drop here</p>
      ) : null}
    </Column>
  );

  // Closed and dismissed sit outside the scrolling area so they are always drop targets.
  const chain = props.columns.filter((c) => !isTerminal(c.stage));
  const terminal = props.columns.filter((c) => isTerminal(c.stage));

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      accessibility={{ announcements }}
      onDragStart={(e) => setActiveId(String(e.active.id))}
      onDragCancel={() => setActiveId(null)}
      onDragEnd={onDragEnd}
    >
      <div className="flex items-start gap-3">
        {chain.length > 0 ? (
          <div className="flex min-w-0 flex-1 items-start gap-3 overflow-x-auto pb-4">
            {chain.map(renderColumn)}
          </div>
        ) : null}
        {terminal.length > 0 ? (
          <div className="flex shrink-0 items-start gap-3 pb-4">{terminal.map(renderColumn)}</div>
        ) : null}
      </div>
      {/* The overlay follows the pointer above every scroll container. */}
      <DragOverlay dropAnimation={null}>
        {active ? <CardPreview opp={{ ...active, stage: props.stageOf(active) }} /> : null}
      </DragOverlay>
    </DndContext>
  );
}
