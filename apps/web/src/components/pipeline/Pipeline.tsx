import { OPPORTUNITY_STAGES, type OpportunityStage } from '@opportun/core';
import { useNavigate } from '@tanstack/react-router';
import { Columns3, Plus, Rows3 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { FormError } from '@/components/FormError';
import { PageHeader } from '@/components/PageHeader';
import { useStageFlow } from '@/components/stage/useStageFlow';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { errorMessage } from '@/lib/api';
import { isTerminal, stageLabel, type OpportunityView } from '@/lib/opportunities';
import { useHotkeys } from '@/lib/useHotkeys';
import { cn } from '@/lib/utils';
import {
  matchesFilter,
  useAllOpportunities,
  useNextDue,
  useReorderOpportunities,
  type PipelineSearch,
} from './data';
import { Kanban, type BoardColumn } from './Kanban';
import { NewOpportunityDialog } from './NewOpportunityDialog';
import { PipelineTable, type TableRowData } from './PipelineTable';

export type { PipelineSearch } from './data';

/** Per-device list of collapsed board columns (stage names). */
export const COLLAPSED_STORAGE_KEY = 'opportun.pipeline.collapsed';

/** Terminal columns start collapsed until the person chooses otherwise. */
function defaultCollapsed(): ReadonlySet<OpportunityStage> {
  return new Set(OPPORTUNITY_STAGES.filter(isTerminal));
}

function readCollapsed(): ReadonlySet<OpportunityStage> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (raw === null) return defaultCollapsed();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultCollapsed();
    return new Set(OPPORTUNITY_STAGES.filter((s) => parsed.includes(s)));
  } catch {
    return defaultCollapsed();
  }
}

/**
 * Manual order (issue #240) wins; `-updatedAt` only breaks a tie among cards nobody has
 * dragged (every one defaults to the same sortOrder), so a board nobody has touched yet
 * keeps exactly today's order, and `id` only breaks a tie within that.
 */
function byBoardOrder(a: OpportunityView, b: OpportunityView): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function writeCollapsed(stages: ReadonlySet<OpportunityStage>): void {
  try {
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...stages]));
  } catch {
    // Storage blocked: the layout still applies for this page view.
  }
}

export function Pipeline(props: {
  search: PipelineSearch;
  onSearchChange: (patch: Partial<PipelineSearch>) => void;
}) {
  const { search, onSearchChange } = props;
  const navigate = useNavigate();
  const { data, error, isPending } = useAllOpportunities();
  const nextDue = useNextDue();
  const flow = useStageFlow();
  const reorder = useReorderOpportunities();
  // Read synchronously on first render so the board never flashes the wrong layout.
  const [collapsed, setCollapsed] = useState<ReadonlySet<OpportunityStage>>(readCollapsed);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  const view = search.view ?? 'board';
  const { overrides } = flow;

  const visible = useMemo(() => {
    const out: { opp: OpportunityView; stage: OpportunityStage }[] = [];
    for (const opp of data?.items ?? []) {
      const stage = overrides.get(opp.id) ?? opp.stage;
      if (matchesFilter(opp, stage, search)) out.push({ opp, stage });
    }
    return out;
  }, [data, overrides, search]);

  const columns = useMemo<BoardColumn[]>(() => {
    const stages = search.stage ? [search.stage] : OPPORTUNITY_STAGES;
    return stages.map((stage) => ({
      stage,
      items: visible
        .filter((v) => v.stage === stage)
        .map((v) => v.opp)
        .sort(byBoardOrder),
      collapsed: collapsed.has(stage) && search.stage !== stage,
    }));
  }, [visible, collapsed, search.stage]);

  const rows = useMemo<TableRowData[]>(
    () => visible.map(({ opp, stage }) => ({ opp, stage, dueAt: nextDue.get(opp.id) })),
    [visible, nextDue],
  );

  /** The selected opportunity, but only when it is actually one of the currently rendered
   *  cards or rows (cards in a collapsed column are not rendered, so a selection left over
   *  from before a column collapsed does not count). */
  function currentItem(): { opp: OpportunityView; stage: OpportunityStage } | undefined {
    const root = container.current;
    if (root === null) return undefined;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-opportunity-id]'));
    return nodes.some((n) => n.dataset.opportunityId === selectedId)
      ? visible.find((v) => v.opp.id === selectedId)
      : undefined;
  }

  /** Moves the selection by one card/row. Returns whether it actually moved, so j/k only claim
   *  the keystroke (and preventDefault) when there was somewhere to move to. */
  function move(delta: 1 | -1): boolean {
    const root = container.current;
    if (root === null) return false;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-opportunity-id]'));
    if (nodes.length === 0) return false;
    const index = nodes.findIndex((n) => n.dataset.opportunityId === selectedId);
    const next = index === -1 ? 0 : Math.min(Math.max(index + delta, 0), nodes.length - 1);
    const node = nodes.at(next);
    if (node === undefined) return false;
    setSelectedId(node.dataset.opportunityId ?? null);
    node.focus();
    return true;
  }

  // Keyboard triage, through the guards every screen's shortcuts share (lib/useHotkeys.ts):
  // j/k move the selection, i marks interested, x dismisses, Enter opens.
  useHotkeys({
    j: (e) => {
      if (move(1)) e.preventDefault();
    },
    k: (e) => {
      if (move(-1)) e.preventDefault();
    },
    i: (e) => {
      const current = currentItem();
      if (current === undefined) return;
      e.preventDefault();
      flow.request({ ...current.opp, stage: current.stage }, 'interested');
    },
    x: (e) => {
      const current = currentItem();
      if (current === undefined) return;
      e.preventDefault();
      flow.dismiss({ ...current.opp, stage: current.stage });
    },
    Enter: (e) => {
      const current = currentItem();
      if (current === undefined) return;
      // Only from the card or row itself: Enter on a link or button keeps its own meaning.
      const target = e.target instanceof Element ? e.target : null;
      const onItem =
        target === null || target === document.body || target.hasAttribute('data-opportunity-id');
      if (!onItem) return;
      e.preventDefault();
      void navigate({ to: '/opportunities/$id', params: { id: current.opp.id } });
    },
  });

  function toggleColumn(stage: OpportunityStage) {
    const next = new Set(collapsed);
    if (next.has(stage)) next.delete(stage);
    else next.add(stage);
    setCollapsed(next);
    writeCollapsed(next);
  }

  const sort = search.sort ?? 'updated';
  const dir = search.dir ?? (search.sort === undefined ? 'desc' : 'asc');

  return (
    <section className="grid min-w-0 grid-cols-1 gap-4">
      <PageHeader
        title="Pipeline"
        description="Track every opportunity from discovery to offer."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" />
            New opportunity
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="View" className="inline-flex rounded-md border bg-card p-0.5">
          {(
            [
              ['board', 'Board', Columns3],
              ['table', 'Table', Rows3],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              aria-pressed={view === value}
              onClick={() => onSearchChange({ view: value === 'board' ? undefined : value })}
              className={cn(
                'inline-flex cursor-pointer items-center gap-1.5 rounded-sm px-2.5 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
                view === value
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
        <Input
          type="search"
          aria-label="Filter opportunities"
          placeholder="Filter by company, title or location"
          className="w-full max-w-xs"
          value={search.q ?? ''}
          onChange={(e) => onSearchChange({ q: e.currentTarget.value || undefined })}
        />
        <div className="w-44">
          <Select
            aria-label="Stage filter"
            value={search.stage ?? ''}
            onChange={(e) => {
              const value = e.currentTarget.value;
              onSearchChange({ stage: OPPORTUNITY_STAGES.find((s) => s === value) });
            }}
          >
            <option value="">All stages</option>
            {OPPORTUNITY_STAGES.map((s) => (
              <option key={s} value={s}>
                {stageLabel(s)}
              </option>
            ))}
          </Select>
        </div>
        <p className="ml-auto hidden text-xs text-muted-foreground lg:block">
          <kbd className="rounded border px-1">j</kbd>/<kbd className="rounded border px-1">k</kbd>{' '}
          select, <kbd className="rounded border px-1">i</kbd> interested,{' '}
          <kbd className="rounded border px-1">x</kbd> dismiss,{' '}
          <kbd className="rounded border px-1">Enter</kbd> open
        </p>
      </div>

      {error ? <FormError message={errorMessage(error)} /> : null}
      {isPending ? <p className="text-sm text-muted-foreground">Loading...</p> : null}

      <div ref={container} className="min-w-0">
        {data === undefined ? null : view === 'table' ? (
          <PipelineTable
            rows={rows}
            sort={sort}
            dir={dir}
            onSort={(s, d) => onSearchChange({ sort: s, dir: d })}
            flow={flow}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        ) : (
          <Kanban
            columns={columns}
            flow={flow}
            selectedId={selectedId}
            nextDue={nextDue}
            onSelect={setSelectedId}
            onToggleColumn={toggleColumn}
            onReorder={reorder}
            reorderDisabled={search.q !== undefined && search.q.trim() !== ''}
            stageOf={(o) => overrides.get(o.id) ?? o.stage}
          />
        )}
      </div>
      {view === 'board' ? (
        <p className="text-xs text-muted-foreground">
          Drag or use <kbd className="rounded border px-1">Space</kbd> then the arrow keys to set a
          card&apos;s order; that position is independent of its{' '}
          <span className="font-medium">Priority</span> badge, which stays a label, not a ranking.
        </p>
      ) : null}

      {flow.dialogs}
      <NewOpportunityDialog open={creating} onOpenChange={setCreating} />
    </section>
  );
}
