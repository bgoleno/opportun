import { participantName } from '@opportun/core';
import { ArrowRightLeft, ChevronDown, ChevronUp, ExternalLink, Mail, Trash2 } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FormError } from '@/components/FormError';
import { Markdown } from '@/components/Markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import {
  activityKindLabel,
  formatDateTime,
  safeHttpUrl,
  timelineSummary,
  type ActivityTimelineItem,
} from '@/lib/opportunities';
import { cn } from '@/lib/utils';
import { useDeleteActivity, useTimeline } from './api';

// Matches .markdown's font-size (0.875rem) and line-height (1.6) in index.css: 10 lines of
// body text is 10 * 1.6 = 16 line-heights, i.e. 14rem at the default 16px root font size.
const COLLAPSED_BODY_HEIGHT = 'max-h-[14rem]';

/**
 * An activity's `bodyMd` is the one timeline section that can run long: a page captured by the
 * browser extension is the entire posting as text (#236). Communications render an already-short
 * `snippet` and stage entries a one-line `note`, so neither needs this.
 *
 * A max-height clamp alone can't say whether anything was cut, so this measures: `scrollHeight`
 * reports the full content height regardless of the clamp, `clientHeight` reports the clamped
 * height while collapsed, and a gap between them means there's more to show. Collapsed content
 * stays in the DOM under `overflow: hidden` rather than `hidden`/unmounted, so it's still findable
 * by the browser's own find-in-page and by screen readers; the tradeoff is that a match can scroll
 * into a region that's clipped from view, which the "Show more" control and edge fade exist to
 * make unsurprising.
 */
function ActivityBody({ bodyMd }: { bodyMd: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyId = useId();

  useLayoutEffect(() => {
    // Only meaningful while the clamp is applied: once expanded, clientHeight tracks the full
    // content and the comparison would wrongly report "not overflowing." Keep the last known
    // collapsed-state answer instead of overwriting it.
    if (expanded) return;
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, bodyMd]);

  return (
    <div className="grid gap-1">
      <div
        ref={bodyRef}
        id={bodyId}
        className={cn(
          'relative',
          !expanded && COLLAPSED_BODY_HEIGHT,
          !expanded && 'overflow-hidden',
          !expanded && overflowing && 'timeline-body-fade',
        )}
      >
        <Markdown>{bodyMd}</Markdown>
      </div>
      {overflowing ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-auto w-fit justify-start gap-1 px-1 py-0.5 text-xs text-muted-foreground"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? (
            <>
              Show less
              <ChevronUp className="size-3.5" aria-hidden="true" />
            </>
          ) : (
            <>
              Show more
              <ChevronDown className="size-3.5" aria-hidden="true" />
            </>
          )}
        </Button>
      ) : null}
    </div>
  );
}

export function TimelineList({ opportunityId }: { opportunityId: string }) {
  const { data, error, isPending } = useTimeline(opportunityId);
  const remove = useDeleteActivity(opportunityId);
  const [deleting, setDeleting] = useState<ActivityTimelineItem | null>(null);

  if (error) return <FormError message={errorMessage(error)} />;
  if (isPending) return <p className="text-sm text-muted-foreground">Loading...</p>;

  return (
    <>
      {data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing on the timeline yet.</p>
      ) : null}
      <ol aria-label="Timeline" className="grid gap-3">
        {data.items.map((item) => (
          <li key={`${item.kind}-${item.id}`} className="grid gap-2 rounded-xl border bg-card p-4">
            <div className="flex flex-wrap items-center gap-2">
              {item.kind === 'activity' ? (
                <Badge variant="secondary">{activityKindLabel(item.activityKind)}</Badge>
              ) : item.kind === 'communication' ? (
                <Badge variant="outline">
                  <Mail aria-hidden="true" />
                  Email
                </Badge>
              ) : (
                <Badge variant="outline">
                  <ArrowRightLeft aria-hidden="true" />
                  Stage
                </Badge>
              )}
              <span className="text-sm font-medium">{timelineSummary(item)}</span>
              <time
                dateTime={new Date(item.occurredAt).toISOString()}
                className="ml-auto text-xs text-muted-foreground"
              >
                {formatDateTime(item.occurredAt)}
              </time>
              {item.kind === 'activity' ? (
                <IconButton
                  variant="ghost"
                  className="size-7 text-muted-foreground"
                  label={`Delete entry: ${item.title}`}
                  onClick={() => setDeleting(item)}
                >
                  <Trash2 aria-hidden="true" />
                </IconButton>
              ) : null}
            </div>
            {item.kind === 'activity' ? (
              <>
                {item.participants.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    With {item.participants.map(participantName).join(', ')}
                  </p>
                ) : null}
                {item.bodyMd ? <ActivityBody bodyMd={item.bodyMd} /> : null}
                {safeHttpUrl(item.externalUrl) ? (
                  <a
                    href={safeHttpUrl(item.externalUrl) ?? undefined}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="inline-flex w-fit items-center gap-1 text-sm text-primary underline underline-offset-2"
                  >
                    {item.externalUrl}
                    <ExternalLink className="size-3.5" aria-hidden="true" />
                  </a>
                ) : null}
              </>
            ) : item.kind === 'communication' ? (
              <>
                <p className="text-xs text-muted-foreground">From {item.from}</p>
                {item.snippet ? (
                  <p className="text-sm text-muted-foreground">{item.snippet}</p>
                ) : null}
              </>
            ) : item.note ? (
              <p className="text-sm text-muted-foreground">{item.note}</p>
            ) : null}
          </li>
        ))}
      </ol>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete this entry?"
        description={deleting ? `"${deleting.title}" will be removed from the timeline.` : ''}
        confirmLabel="Delete"
        onConfirm={async () => {
          if (deleting === null) return;
          try {
            await remove.mutateAsync(deleting.id);
          } catch (err) {
            toast({
              title: 'Could not delete',
              description: errorMessage(err),
              variant: 'destructive',
            });
          }
        }}
      />
    </>
  );
}
