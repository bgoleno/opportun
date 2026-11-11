// Settings > AI traces (FR-T7, https://github.com/bgoleno/opportun/issues/347): the caller's own
// AI traces, newest first, filterable by task, model, provider, status, time range and
// conversation. A chat's turns are grouped under their conversation. Nothing here shows prompt
// or response content: none is stored (design.md 14.7).
//
// The filters live in the URL (the route owns them), so a filtered view can be linked to and
// the browser's back button undoes a filter.
import { Link } from '@tanstack/react-router';
import { useId } from 'react';
import { FormError } from '@/components/FormError';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/opportunities';
import {
  RANGES,
  type RangeValue,
  type TraceFilters,
  type TraceStatus,
  type TraceView,
  useTraceFilterValues,
  useTraces,
} from './api';
import { formatDuration, formatInt, formatUsd, statusLabel } from './format';

export interface TracesPageProps {
  isAdmin: boolean;
  filters: TraceFilters;
  onFiltersChange: (next: TraceFilters) => void;
}

/** One entry of the list: a trace on its own, or a conversation with its turns. */
type Entry =
  { kind: 'trace'; trace: TraceView } | { kind: 'conversation'; id: string; turns: TraceView[] };

/**
 * Groups a chat's turns under their conversation, placed where its newest loaded turn is. The
 * list is newest first, so each group's turns stay newest first too.
 */
export function groupByConversation(traces: readonly TraceView[]): Entry[] {
  const entries: Entry[] = [];
  const groups = new Map<string, TraceView[]>();
  for (const t of traces) {
    if (t.conversationId === null) {
      entries.push({ kind: 'trace', trace: t });
      continue;
    }
    const turns = groups.get(t.conversationId);
    if (turns !== undefined) turns.push(t);
    else {
      const fresh = [t];
      groups.set(t.conversationId, fresh);
      entries.push({ kind: 'conversation', id: t.conversationId, turns: fresh });
    }
  }
  return entries;
}

export function TracesPage({ isAdmin, filters, onFiltersChange }: TracesPageProps) {
  const traces = useTraces(filters);
  const pages = traces.data?.pages ?? [];
  const items = pages.flatMap((p) => p.items);
  const collect = pages[0]?.collect;
  const filtered = Object.values(filters).some((v) => v !== undefined);

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>AI traces</CardTitle>
          <CardDescription>
            Each AI call, chat turn and workflow you ran, with its timing, tokens and estimated
            cost. Prompts and responses are not recorded. Traces are kept 30 days.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {collect === false ? <CollectOff isAdmin={isAdmin} hasTraces={items.length > 0} /> : null}
          <Filters filters={filters} onChange={onFiltersChange} />
          {filters.conversation !== undefined ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>Showing one conversation.</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onFiltersChange({ ...filters, conversation: undefined })}
              >
                Show all traces
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {traces.isError ? <FormError message={errorMessage(traces.error)} /> : null}
      {traces.isPending ? <p className="text-sm text-muted-foreground">Loading traces...</p> : null}
      {traces.isSuccess && items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {filtered ? 'No traces match these filters.' : 'No AI traces yet.'}
        </p>
      ) : null}
      {items.length > 0 ? (
        <ul aria-label="Traces" className="grid gap-2">
          {groupByConversation(items).map((e) =>
            e.kind === 'trace' ? (
              <li key={e.trace.traceId}>
                <TraceRow trace={e.trace} />
              </li>
            ) : (
              <li key={`c-${e.id}`}>
                <ConversationGroup
                  turns={e.turns}
                  showOnly={
                    filters.conversation === undefined
                      ? () => onFiltersChange({ ...filters, conversation: e.id })
                      : undefined
                  }
                />
              </li>
            ),
          )}
        </ul>
      ) : null}
      {traces.hasNextPage ? (
        <div>
          <Button
            variant="outline"
            onClick={() => void traces.fetchNextPage()}
            disabled={traces.isFetchingNextPage}
          >
            {traces.isFetchingNextPage ? 'Loading...' : 'Load more'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * While collection is off nothing new is recorded (design.md 14.1). The switch has no Settings
 * card until FR-T2 (https://github.com/bgoleno/opportun/issues/342), so an admin gets the words
 * and no link: whichever of FR-T2 and FR-T7 merges second adds the link (tl on #347).
 */
function CollectOff({ isAdmin, hasTraces }: { isAdmin: boolean; hasTraces: boolean }) {
  return (
    <div role="status" className="rounded-md border bg-muted/50 p-3 text-sm">
      <p className="font-medium">Collection is off, so no new traces are being recorded.</p>
      <p className="text-muted-foreground">
        {isAdmin
          ? 'An admin can turn it on in Settings once telemetry settings are available.'
          : 'Ask an admin to turn it on.'}
        {hasTraces ? ' Traces collected earlier are still shown.' : null}
      </p>
    </div>
  );
}

const ANY = '';

function Filters({
  filters,
  onChange,
}: {
  filters: TraceFilters;
  onChange: (f: TraceFilters) => void;
}) {
  const values = useTraceFilterValues();
  const id = useId();
  const set = (patch: TraceFilters) => onChange({ ...filters, ...patch });
  const pick = (v: string) => (v === ANY ? undefined : v);
  // A value the URL names that the caller has no span with is still offered, so the control
  // shows what is applied.
  const options = (known: readonly string[] | undefined, current: string | undefined) =>
    current === undefined || (known ?? []).includes(current)
      ? (known ?? [])
      : [current, ...(known ?? [])];

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <FilterSelect
        id={`${id}-task`}
        label="Task"
        value={filters.task}
        options={options(values.data?.tasks, filters.task)}
        onChange={(v) => set({ task: pick(v) })}
      />
      <FilterSelect
        id={`${id}-model`}
        label="Model"
        value={filters.model}
        options={options(values.data?.models, filters.model)}
        onChange={(v) => set({ model: pick(v) })}
      />
      <FilterSelect
        id={`${id}-provider`}
        label="Provider"
        value={filters.provider}
        options={options(values.data?.providers, filters.provider)}
        onChange={(v) => set({ provider: pick(v) })}
      />
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-status`}>Status</Label>
        <Select
          id={`${id}-status`}
          value={filters.status ?? ANY}
          onChange={(e) => set({ status: pick(e.target.value) as TraceStatus | undefined })}
        >
          <option value={ANY}>Any</option>
          <option value="ok">OK</option>
          <option value="error">Error</option>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-range`}>Time range</Label>
        <Select
          id={`${id}-range`}
          value={filters.range ?? ANY}
          onChange={(e) => set({ range: pick(e.target.value) as RangeValue | undefined })}
        >
          <option value={ANY}>All kept traces</option>
          {RANGES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}

function FilterSelect(props: {
  id: string;
  label: string;
  value: string | undefined;
  options: readonly string[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Select
        id={props.id}
        value={props.value ?? ANY}
        onChange={(e) => props.onChange(e.target.value)}
      >
        <option value={ANY}>Any</option>
        {props.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </Select>
    </div>
  );
}

function StatusBadge({ status }: { status: TraceStatus }) {
  return (
    <Badge variant={status === 'ok' ? 'secondary' : 'destructive'}>{statusLabel(status)}</Badge>
  );
}

/** What a trace did: its tasks, else its workflow, else its feature, else where it started. */
function traceTitle(t: TraceView): string {
  if (t.tasks.length > 0) return t.tasks.join(', ');
  return t.workflow ?? t.feature ?? t.origin;
}

function TraceRow({ trace: t }: { trace: TraceView }) {
  return (
    <Link
      to="/settings/traces/$traceId"
      params={{ traceId: t.traceId }}
      className="block rounded-md border bg-card p-3 text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{traceTitle(t)}</span>
        <StatusBadge status={t.status} />
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground tabular-nums">
        <span>{formatDateTime(t.startedAt)}</span>
        {t.models.length > 0 ? (
          <span className="[overflow-wrap:anywhere]">{t.models.join(', ')}</span>
        ) : null}
        <span>{formatDuration(t.durationMs)}</span>
        <span>
          {formatInt(t.inputTokens)} in, {formatInt(t.outputTokens)} out
        </span>
        <span>{formatUsd(t.estCostUsd)}</span>
        {t.errorCount > 0 ? (
          <span className="text-destructive">{formatInt(t.errorCount)} failed</span>
        ) : null}
      </div>
    </Link>
  );
}

function ConversationGroup({
  turns,
  showOnly,
}: {
  turns: TraceView[];
  showOnly: (() => void) | undefined;
}) {
  const label = `Tailoring chat, ${turns.length} ${turns.length === 1 ? 'turn' : 'turns'}`;
  return (
    <div role="group" aria-label={label} className="grid gap-2 rounded-md border border-dashed p-2">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <span className="text-sm font-medium">{label}</span>
        {showOnly !== undefined ? (
          <Button variant="ghost" size="sm" onClick={showOnly}>
            Show only this conversation
          </Button>
        ) : null}
      </div>
      <ul className="grid gap-2">
        {turns.map((t) => (
          <li key={t.traceId}>
            <TraceRow trace={t} />
          </li>
        ))}
      </ul>
    </div>
  );
}
