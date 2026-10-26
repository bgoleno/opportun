// Table view. Plain (non-virtualized) rows: a personal pipeline is far below the few
// hundred rows where virtualization pays off, and it keeps rows in the DOM for find-in-page.
import { OPPORTUNITY_STAGES, type OpportunityStage } from '@opportun/core';
import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_text,
  tableFeatures,
  useTable,
  type SortingState,
} from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { useMemo } from 'react';
import { CompanyLink } from '@/components/opportunity/CompanyLink';
import { StageMenu } from '@/components/stage/StageMenu';
import { subjectLabel, type StageFlow } from '@/components/stage/useStageFlow';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  formatDate,
  priorityLabel,
  sourceKindLabel,
  type OpportunityView,
} from '@/lib/opportunities';
import { cn } from '@/lib/utils';
import type { SortKey } from './data';

export interface TableRowData {
  opp: OpportunityView;
  stage: OpportunityStage;
  dueAt: number | undefined;
}

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { text: sortFn_text },
});
const col = createColumnHelper<typeof features, TableRowData>();

const columns = col.columns([
  col.accessor((r) => r.opp.companyName, { id: 'company', header: 'Company', sortFn: 'text' }),
  col.accessor((r) => r.opp.title, { id: 'title', header: 'Title', sortFn: 'text' }),
  col.accessor((r) => OPPORTUNITY_STAGES.indexOf(r.stage), { id: 'stage', header: 'Stage' }),
  // Where this one came from (issue #201), quiet in a table the same way it is on a card:
  // plain text, not a badge, matching this view's own treatment of every other fact column.
  col.accessor((r) => sourceKindLabel(r.opp.sourceKind), {
    id: 'source',
    header: 'Source',
    sortFn: 'text',
  }),
  col.accessor((r) => r.opp.updatedAt, { id: 'updated', header: 'Updated' }),
  col.accessor((r) => r.opp.priority, { id: 'priority', header: 'Priority' }),
  col.accessor((r) => r.dueAt, { id: 'due', header: 'Next step due', sortUndefined: 'last' }),
  // The board's manual order as a sort option (issue #240), not a second drag surface.
  col.accessor((r) => r.opp.sortOrder, { id: 'order', header: 'Order' }),
]);

export function PipelineTable(props: {
  rows: TableRowData[];
  sort: SortKey;
  dir: 'asc' | 'desc';
  onSort: (sort: SortKey, dir: 'asc' | 'desc') => void;
  flow: StageFlow;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const sorting = useMemo<SortingState>(
    () => [{ id: props.sort, desc: props.dir === 'desc' }],
    [props.sort, props.dir],
  );
  const table = useTable({
    features,
    columns,
    data: props.rows,
    getRowId: (r) => r.opp.id,
    state: { sorting },
    enableSortingRemoval: false,
  });
  const rows = table.getRowModel().rows;

  return (
    <div className="rounded-xl border bg-card">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => {
                const id = header.column.id as SortKey;
                const active = props.sort === id;
                const Icon = !active ? ArrowUpDown : props.dir === 'asc' ? ArrowUp : ArrowDown;
                const title = String(header.column.columnDef.header);
                return (
                  <TableHead
                    key={header.id}
                    aria-sort={active ? (props.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    <button
                      type="button"
                      aria-label={`Sort by ${title}`}
                      onClick={() =>
                        props.onSort(id, active && props.dir === 'asc' ? 'desc' : 'asc')
                      }
                      className="inline-flex cursor-pointer items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {title}
                      <Icon
                        className={cn('size-3.5', !active && 'opacity-40')}
                        aria-hidden="true"
                      />
                    </button>
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={columns.length}
                className="py-8 text-center text-muted-foreground"
              >
                No opportunities match.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => {
              const { opp, stage, dueAt } = row.original;
              const selected = props.selectedId === opp.id;
              return (
                <TableRow
                  key={row.id}
                  tabIndex={0}
                  aria-label={subjectLabel(opp)}
                  aria-current={selected ? 'true' : undefined}
                  data-opportunity-id={opp.id}
                  onFocus={(e) => {
                    if (e.target === e.currentTarget) props.onSelect(opp.id);
                  }}
                  className={cn(
                    'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                    selected && 'bg-accent text-accent-foreground',
                  )}
                >
                  <TableCell>
                    <CompanyLink name={opp.companyName} domain={opp.companyDomain} />
                  </TableCell>
                  <TableCell>
                    <Link
                      to="/opportunities/$id"
                      params={{ id: opp.id }}
                      tabIndex={-1}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {opp.title}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StageMenu opp={{ ...opp, stage }} flow={props.flow} className="-ml-2" />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {sourceKindLabel(opp.sourceKind)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(opp.updatedAt)}
                  </TableCell>
                  <TableCell>{priorityLabel(opp.priority)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {dueAt === undefined ? '' : formatDate(dueAt)}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
