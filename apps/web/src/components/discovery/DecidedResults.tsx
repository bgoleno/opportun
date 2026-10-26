// Decided discovery results (#97): accepted and dismissed results, each with the unsuppress
// action #96 added so a reopened requisition, or a dismissed-then-reconsidered posting, can come
// back through discovery instead of being treated as a duplicate forever.
//
// A result whose dedupe key is already released (dedupeKey: null) renders as an "Unsuppressed"
// badge rather than an active button. Reversing a decision and never having made one are
// different states; collapsing them into one undifferentiated "decided" row would leave no way
// to tell, at a glance, which rows were already reopened and which still hold their key, and the
// owner would end up re-deciding ones he already settled.
import type { DismissReason } from '@opportun/core';
import { Link } from '@tanstack/react-router';
import { ExternalLink, Undo2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { FormError } from '@/components/FormError';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { dismissReasonLabel, formatDateTime, safeHttpUrl } from '@/lib/opportunities';
import { useHotkeys } from '@/lib/useHotkeys';
import { cn } from '@/lib/utils';
import {
  sourceKindLabel,
  useDecidedResults,
  useUnsuppressResult,
  type DecidedTab,
  type DiscoveryResult,
} from './api';
import { resultLabel, ScoreBadge } from './QueueRow';

const TABS: { tab: DecidedTab; label: string; empty: string; note: string }[] = [
  {
    tab: 'dismissed',
    label: 'Dismissed',
    empty: 'Nothing dismissed yet.',
    note: 'Results you passed on. Unsuppress one to let a later repost of the same job back into the review queue, instead of it being skipped as a duplicate forever.',
  },
  {
    tab: 'accepted',
    label: 'Accepted',
    empty: 'Nothing accepted yet.',
    note: "Results already in your pipeline. Unsuppress only takes effect once the linked opportunity is itself dismissed; while it's still active, a repost should keep being treated as the same job.",
  },
];

export function DecidedResults() {
  return (
    <Tabs defaultValue="dismissed">
      <TabsList>
        {TABS.map((t) => (
          <TabsTrigger key={t.tab} value={t.tab}>
            {t.label}
            <TabCount tab={t.tab} />
          </TabsTrigger>
        ))}
      </TabsList>
      {TABS.map((t) => (
        <TabsContent key={t.tab} value={t.tab} className="grid gap-3 pt-2">
          <p className="text-sm text-muted-foreground">{t.note}</p>
          <ResultList tab={t.tab} label={t.label} empty={t.empty} />
        </TabsContent>
      ))}
    </Tabs>
  );
}

function TabCount({ tab }: { tab: DecidedTab }) {
  const { data } = useDecidedResults(tab);
  if (data === undefined || data.total === 0) return null;
  return <span className="ml-1 text-xs tabular-nums">({data.total})</span>;
}

/** Moves the selection to the next/previous `[data-result-id]` node inside `root`. Returns
 *  whether it actually moved, so the caller only claims the keystroke when it did something. */
function moveSelection(
  root: HTMLElement | null,
  currentId: string | null,
  delta: 1 | -1,
  setSelectedId: (id: string | null) => void,
): boolean {
  if (root === null) return false;
  const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-result-id]'));
  if (nodes.length === 0) return false;
  const index = nodes.findIndex((n) => n.dataset.resultId === currentId);
  const next = index === -1 ? 0 : Math.min(Math.max(index + delta, 0), nodes.length - 1);
  const node = nodes.at(next);
  if (node === undefined) return false;
  setSelectedId(node.dataset.resultId ?? null);
  node.focus();
  return true;
}

function ResultList({ tab, label, empty }: { tab: DecidedTab; label: string; empty: string }) {
  const { data, error, isPending } = useDecidedResults(tab);
  const unsuppress = useUnsuppressResult();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const container = useRef<HTMLUListElement>(null);
  const items = data?.items;

  function unsuppressResult(r: DiscoveryResult) {
    unsuppress.mutate(r.id, {
      onSuccess: () =>
        toast({ title: 'Unsuppressed', description: resultLabel(r), variant: 'success' }),
      onError: (err) =>
        toast({
          title: 'Not unsuppressed',
          description: errorMessage(err),
          variant: 'destructive',
        }),
    });
  }

  // Same guards as the review queue's own handler (ReviewQueue.tsx), the reference
  // implementation this hook was extracted from (issue #155).
  useHotkeys({
    j: (e) => {
      if (moveSelection(container.current, selectedId, 1, setSelectedId)) e.preventDefault();
    },
    k: (e) => {
      if (moveSelection(container.current, selectedId, -1, setSelectedId)) e.preventDefault();
    },
    u: (e) => {
      const current = items?.find((r) => r.id === selectedId);
      // No dedupe key to release, no button on the row either: the key is just as inert.
      if (current === undefined || current.dedupeKey === null) return;
      e.preventDefault();
      unsuppressResult(current);
    },
  });

  if (error) return <FormError message={errorMessage(error)} />;
  if (isPending) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (data.items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <>
      <p className="hidden text-xs text-muted-foreground lg:block">
        <kbd className="rounded border px-1">j</kbd>/<kbd className="rounded border px-1">k</kbd>{' '}
        select, <kbd className="rounded border px-1">u</kbd> unsuppress
      </p>
      <ul ref={container} className="grid gap-3" aria-label={`${label} results`}>
        {data.items.map((r) => (
          <DecidedRow
            key={r.id}
            result={r}
            selected={r.id === selectedId}
            onSelect={() => setSelectedId(r.id)}
            unsuppressing={unsuppress.isPending}
            onUnsuppress={() => unsuppressResult(r)}
          />
        ))}
      </ul>
    </>
  );
}

function DecidedRow({
  result: r,
  selected,
  onSelect,
  unsuppressing,
  onUnsuppress,
}: {
  result: DiscoveryResult;
  selected: boolean;
  onSelect: () => void;
  unsuppressing: boolean;
  onUnsuppress: () => void;
}) {
  const p = r.posting;
  const href = safeHttpUrl(p.postingUrl);
  const label = resultLabel(r);
  const suppressing = r.dedupeKey !== null;

  return (
    <li
      data-result-id={r.id}
      tabIndex={0}
      aria-label={label}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
      onFocus={onSelect}
      className={cn(
        'grid gap-2 rounded-xl border bg-card p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'border-primary ring-1 ring-primary',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ScoreBadge score={r.aiScore} />
        <Badge variant="secondary">{sourceKindLabel(r.sourceKind)}</Badge>
        {p.location ? (
          <span className="min-w-0 truncate text-sm text-muted-foreground">{p.location}</span>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground">
          {r.disposition === 'dismissed' ? 'Dismissed' : 'Accepted'} {formatDateTime(r.updatedAt)}
        </span>
      </div>
      <div className="grid gap-0.5">
        <span className="font-medium break-words">{p.title}</span>
        <span className="text-sm break-words text-muted-foreground">{p.company}</span>
      </div>
      {r.dismissReason !== null ? (
        <p className="text-xs text-muted-foreground">
          Dismissed: {dismissReasonLabel(r.dismissReason as DismissReason)}
          {/* issue #199: the denied company's own name, so this reads as "Oracle" rather than
           *  a bare reason label that leaves the reader to guess which company matched. */}
          {r.dismissReason === 'denied_company' && r.dismissNote !== null
            ? ` (${r.dismissNote})`
            : ''}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {r.opportunityId !== null ? (
          <Link
            to="/opportunities/$id"
            params={{ id: r.opportunityId }}
            className="text-sm font-medium text-primary underline underline-offset-2"
          >
            View opportunity
          </Link>
        ) : null}
        {href !== null ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="inline-flex items-center gap-1 text-sm text-primary underline underline-offset-2"
          >
            Posting
            <ExternalLink aria-hidden="true" className="size-3.5" />
          </a>
        ) : null}
        <div className="ml-auto">
          {suppressing ? (
            <Button
              size="sm"
              variant="outline"
              disabled={unsuppressing}
              onClick={onUnsuppress}
              aria-label={`Unsuppress ${label}`}
            >
              <Undo2 aria-hidden="true" />
              Unsuppress
            </Button>
          ) : (
            <Badge
              variant="secondary"
              aria-label={`${label}: unsuppressed, a repost is no longer treated as a duplicate`}
            >
              Unsuppressed
            </Badge>
          )}
        </div>
      </div>
    </li>
  );
}
