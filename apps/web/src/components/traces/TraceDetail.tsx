// One AI trace (FR-T7, https://github.com/bgoleno/opportun/issues/347): a waterfall of its spans
// on one time axis, nested by parent, and the selected span's attributes.
//
// The waterfall is plain markup, with no chart library (design.md 14.12). It is an ARIA tree:
// one tab stop, the arrow keys move through the spans and select as they go, Home and End jump
// to the first and last. At phone width each row keeps its name above its bar, so nothing
// scrolls sideways.
//
// No content is shown, because none is stored (14.7). The view links to where it lives: a chat
// trace to its tailoring session, and a span to the prompts, named by task and version.
import { Link } from '@tanstack/react-router';
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react';
import { FormError } from '@/components/FormError';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/opportunities';
import { cn } from '@/lib/utils';
import { type AttrValue, type SpanView, type TraceDetail, useTrace } from './api';
import { formatDuration, formatInt, formatUsd, statusLabel } from './format';
import { buildWaterfall, type WaterfallRow } from './waterfall';

function BackLink() {
  return (
    <Link
      to="/settings/traces"
      className="text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      All traces
    </Link>
  );
}

export function TraceDetailPage({ traceId }: { traceId: string }) {
  const q = useTrace(traceId);
  if (q.isPending) return <p className="text-sm text-muted-foreground">Loading trace...</p>;
  if (q.isError) {
    const missing = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="grid gap-3">
        {missing ? (
          <p className="text-sm">Trace not found. It may have aged out: traces are kept 30 days.</p>
        ) : (
          <FormError message={errorMessage(q.error)} />
        )}
        <div>
          <BackLink />
        </div>
      </div>
    );
  }
  return <TraceView detail={q.data} />;
}

function TraceView({ detail }: { detail: TraceDetail }) {
  const { trace: t, spans, conversation } = detail;
  const rows = buildWaterfall(spans, t.startedAt, t.durationMs);
  const [selectedId, setSelectedId] = useState<string | undefined>(rows[0]?.span.spanId);
  const selected = rows.find((r) => r.span.spanId === selectedId)?.span;

  return (
    <div className="grid gap-4">
      <div>
        <BackLink />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <span className="break-words">{t.workflow ?? (t.tasks.join(', ') || t.origin)}</span>
            <Badge variant={t.status === 'ok' ? 'secondary' : 'destructive'}>
              {statusLabel(t.status)}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            <Fact term="Started">{formatDateTime(t.startedAt)}</Fact>
            <Fact term="Duration">{formatDuration(t.durationMs)}</Fact>
            <Fact term="Started by">
              <span className="break-all">{t.origin}</span>
            </Fact>
            {t.feature !== null ? <Fact term="Feature">{t.feature}</Fact> : null}
            {t.models.length > 0 ? (
              <Fact term="Models">
                <span className="break-all">{t.models.join(', ')}</span>
              </Fact>
            ) : null}
            <Fact term="Tokens">
              {formatInt(t.inputTokens)} in, {formatInt(t.outputTokens)} out
            </Fact>
            <Fact term="Estimated cost">{formatUsd(t.estCostUsd)}</Fact>
            <Fact term="Spans">
              {formatInt(t.spanCount)}
              {t.errorCount > 0 ? `, ${formatInt(t.errorCount)} failed` : ''}
            </Fact>
          </dl>
          {t.truncated ? (
            <p className="text-muted-foreground">
              This trace reached the limit of 2,000 spans and was truncated: later spans were not
              kept.
            </p>
          ) : null}
          {conversation !== null ? (
            <p>
              Part of a tailoring chat.{' '}
              <Link
                to="/resumes/$id"
                params={{ id: conversation.resumeId }}
                className="font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                Open the tailoring session
              </Link>
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Waterfall</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No spans were kept for this trace.</p>
          ) : (
            <Waterfall rows={rows} selectedId={selectedId} onSelect={setSelectedId} />
          )}
          {selected !== undefined ? <SpanDetails span={selected} /> : null}
        </CardContent>
      </Card>
    </div>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="font-medium tabular-nums">{children}</dd>
    </div>
  );
}

/** Indentation per nesting level, in rem; capped so a deep trace still fits a phone. */
const INDENT_REM = 0.75;
const MAX_INDENT_LEVELS = 8;

function Waterfall({
  rows,
  selectedId,
  onSelect,
}: {
  rows: WaterfallRow[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const items = useRef(new Map<number, HTMLLIElement>());
  const selectedIndex = Math.max(
    0,
    rows.findIndex((r) => r.span.spanId === selectedId),
  );

  const moveTo = (i: number) => {
    const row = rows.at(i);
    if (row === undefined) return;
    onSelect(row.span.spanId);
    items.current.get(i)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const target = new Map([
      ['ArrowDown', selectedIndex + 1],
      ['ArrowUp', selectedIndex - 1],
      ['Home', 0],
      ['End', rows.length - 1],
    ]).get(e.key);
    if (target === undefined) return;
    e.preventDefault();
    moveTo(Math.min(rows.length - 1, Math.max(0, target)));
  };

  return (
    <ul role="tree" aria-label="Spans" className="grid gap-1" onKeyDown={onKeyDown}>
      {rows.map((r, i) => {
        const s = r.span;
        const isSelected = i === selectedIndex;
        return (
          <li
            key={s.spanId}
            ref={(el) => {
              if (el === null) items.current.delete(i);
              else items.current.set(i, el);
            }}
            role="treeitem"
            aria-level={r.depth + 1}
            aria-selected={isSelected}
            tabIndex={isSelected ? 0 : -1}
            onClick={() => moveTo(i)}
            className={cn(
              'grid cursor-pointer gap-1 rounded-md px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50',
            )}
          >
            <div
              className="flex min-w-0 flex-wrap items-baseline gap-x-2"
              style={{ paddingLeft: `${Math.min(r.depth, MAX_INDENT_LEVELS) * INDENT_REM}rem` }}
            >
              <span className="min-w-0 font-medium break-all">{s.name}</span>
              <span className="text-muted-foreground tabular-nums">
                +{formatDuration(r.offsetMs)}, {formatDuration(s.durationMs)}
              </span>
              {s.status === 'error' ? (
                <span className="text-destructive">{s.errorType ?? 'error'}</span>
              ) : null}
            </div>
            {/* The bar repeats the offset and duration above, which are the accessible form. */}
            <div aria-hidden="true" className="relative h-2 rounded-sm bg-muted">
              <div
                className={cn(
                  'absolute inset-y-0 rounded-sm',
                  s.status === 'error' ? 'bg-destructive' : 'bg-primary',
                )}
                style={{ left: `${r.offsetPct}%`, width: `${r.widthPct}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function formatValue(v: AttrValue): string {
  return Array.isArray(v) ? v.join(', ') : String(v);
}

function SpanDetails({ span: s }: { span: SpanView }) {
  const headingId = useId();
  const attrs = Object.entries(s.attributes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    <section aria-labelledby={headingId} className="grid gap-2 rounded-md border p-3 text-sm">
      <h3 id={headingId} className="font-semibold break-all">
        Span details: {s.name}
      </h3>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        <Fact term="Kind">{s.kind}</Fact>
        <Fact term="Duration">{formatDuration(s.durationMs)}</Fact>
        <Fact term="Status">
          {statusLabel(s.status)}
          {s.errorType !== null ? ` (${s.errorType})` : ''}
        </Fact>
        {s.task !== null ? <Fact term="Task">{s.task}</Fact> : null}
        {s.model !== null ? (
          <Fact term="Model">
            <span className="break-all">{s.model}</span>
          </Fact>
        ) : null}
        {s.provider !== null ? <Fact term="Provider">{s.provider}</Fact> : null}
        {s.prompt !== null ? (
          <Fact term="Prompt">
            {s.prompt.name}
            {s.prompt.version !== null ? `, version ${s.prompt.version}` : ''}{' '}
            <Link
              to="/settings/ai"
              className="font-normal text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              View prompts
            </Link>
          </Fact>
        ) : null}
      </dl>
      {attrs.length > 0 ? (
        <>
          <h4 className="mt-2 font-medium">Attributes</h4>
          <dl className="grid gap-1">
            {attrs.map(([k, v]) => (
              <div key={k} className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                <dt className="font-mono text-xs break-all text-muted-foreground">{k}</dt>
                <dd className="font-mono text-xs break-all">{formatValue(v)}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : (
        <p className="text-muted-foreground">No attributes were recorded for this span.</p>
      )}
    </section>
  );
}
