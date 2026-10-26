// One pending discovery result, or (issue #191) a group of results sharing a company+title
// dedupeKey prefix that differ only by location. The posting is third-party data: every field
// is rendered as a React text node (never markdown, never HTML), and a posting link is offered
// only for http(s).
import type { Resolution } from '@opportun/core';
import { Check, ExternalLink, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { safeHttpUrl } from '@/lib/opportunities';
import { cn } from '@/lib/utils';
import { resolutionLabel, sourceKindLabel, type DiscoveryResult } from './api';
import { rowKey, type ResultGroup } from './groupResults';

/** Longest description excerpt shown in the row (the detail dialog shows all of it). */
const EXCERPT = 280;

export function excerpt(text: string | null | undefined, max = EXCERPT): string | null {
  if (text == null) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export const resultLabel = (r: DiscoveryResult): string =>
  `${r.posting.title} at ${r.posting.company}`;

export function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) {
    return (
      <Badge variant="outline" aria-label="Not scored yet">
        Unscored
      </Badge>
    );
  }
  const rounded = Math.round(score);
  return (
    <Badge
      variant={rounded >= 70 ? 'success' : rounded >= 40 ? 'secondary' : 'outline'}
      aria-label={`AI score ${rounded} of 100`}
      className="tabular-nums"
    >
      {rounded}
    </Badge>
  );
}

const NEEDS_ATTENTION: readonly Resolution[] = ['needs_capture', 'capture_failed'];

export function ResolutionChip({ resolution }: { resolution: Resolution }) {
  return (
    <Badge variant={NEEDS_ATTENTION.includes(resolution) ? 'destructive' : 'outline'}>
      {resolutionLabel(resolution)}
    </Badge>
  );
}

export function QueueRow(props: {
  result: DiscoveryResult;
  selected: boolean;
  onSelect: () => void;
  onAccept: () => void;
  onDismiss: () => void;
  onOpen: () => void;
  /** Bulk-triage checkbox state (#184), independent of `selected` (the keyboard-focus cursor):
   *  many rows can be checked for a batch at once, only one is ever the keyboard cursor. */
  checked: boolean;
  /** Fires on a checkbox click, with whether Shift was held (range-select against the last
   *  checkbox clicked), not on activation via keyboard. */
  onToggleChecked: (shiftKey: boolean) => void;
}) {
  const { result: r, selected } = props;
  const p = r.posting;
  const href = safeHttpUrl(p.postingUrl);
  const description = excerpt(p.descriptionMd);
  const label = resultLabel(r);
  return (
    <li
      data-result-id={r.id}
      tabIndex={0}
      aria-label={label}
      aria-current={selected ? 'true' : undefined}
      onClick={props.onSelect}
      onFocus={props.onSelect}
      className={cn(
        'grid gap-2 rounded-xl border bg-card p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'border-primary ring-1 ring-primary',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Checkbox
          checked={props.checked}
          onClick={(e) => {
            e.stopPropagation();
            props.onToggleChecked(e.shiftKey);
          }}
          aria-label={`Select ${label}`}
        />
        <ScoreBadge score={r.aiScore} />
        <ResolutionChip resolution={r.resolution} />
        <Badge variant="secondary">{sourceKindLabel(r.sourceKind)}</Badge>
        {p.location ? (
          <span className="min-w-0 truncate text-sm text-muted-foreground">{p.location}</span>
        ) : null}
        {p.remote === true ? <Badge variant="outline">Remote</Badge> : null}
      </div>
      <div className="grid gap-0.5">
        <button
          type="button"
          onClick={props.onOpen}
          className="w-fit text-left font-medium break-words underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {p.title}
        </button>
        <span className="text-sm break-words text-muted-foreground">{p.company}</span>
      </div>
      {r.aiRationale ? (
        <p className="text-sm break-words">
          <span className="text-muted-foreground">Why: </span>
          {r.aiRationale}
        </p>
      ) : null}
      {description ? (
        <p className="line-clamp-2 text-sm break-words text-muted-foreground">{description}</p>
      ) : null}
      {p.compNote ? <p className="text-sm break-words">{p.compNote}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={props.onAccept} aria-label={`Accept ${label}`}>
          <Check aria-hidden="true" />
          Accept
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={props.onDismiss}
          aria-label={`Dismiss ${label}`}
        >
          <X aria-hidden="true" />
          Dismiss
        </Button>
        {href !== null ? (
          <Button asChild size="sm" variant="outline">
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              aria-label={`Open posting for ${label}`}
            >
              <ExternalLink aria-hidden="true" />
              Posting
            </a>
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/**
 * A group of pending results that share a company+title dedupeKey prefix and differ only by
 * location (issue #191): the title and company render once, every member's location is listed
 * (linked when that member has its own posting url), and Accept/Dismiss act on the whole group
 * in one triage decision rather than requiring one per location. The underlying rows stay
 * distinct -- this is a display grouping only, nothing about dedupeKey or identity changes.
 */
export function QueueGroupRow(props: {
  group: ResultGroup;
  selected: boolean;
  onSelect: () => void;
  onAcceptAll: () => void;
  onDismissAll: () => void;
  onOpen: () => void;
}) {
  const { group, selected } = props;
  const primary = group.members[0]!;
  const p = primary.posting;
  const label = resultLabel(primary);
  const n = group.members.length;
  return (
    <li
      data-result-id={rowKey(group)}
      tabIndex={0}
      aria-label={`${label}, ${n} locations`}
      aria-current={selected ? 'true' : undefined}
      onClick={props.onSelect}
      onFocus={props.onSelect}
      className={cn(
        'grid gap-2 rounded-xl border bg-card p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'border-primary ring-1 ring-primary',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ScoreBadge score={primary.aiScore} />
        <Badge variant="secondary">{n} locations</Badge>
        <Badge variant="secondary">{sourceKindLabel(primary.sourceKind)}</Badge>
      </div>
      <div className="grid gap-0.5">
        <button
          type="button"
          onClick={props.onOpen}
          className="w-fit text-left font-medium break-words underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {p.title}
        </button>
        <span className="text-sm break-words text-muted-foreground">{p.company}</span>
      </div>
      <ul
        className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground"
        aria-label="Locations"
      >
        {group.members.map((m) => {
          const loc = m.posting.location ?? 'Unspecified location';
          const href = safeHttpUrl(m.posting.postingUrl);
          return (
            <li key={m.id}>
              {href !== null ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="underline-offset-2 hover:underline"
                >
                  {loc}
                </a>
              ) : (
                loc
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={props.onAcceptAll} aria-label={`Accept all ${n} for ${label}`}>
          <Check aria-hidden="true" />
          Accept all {n}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={props.onDismissAll}
          aria-label={`Dismiss all ${n} for ${label}`}
        >
          <X aria-hidden="true" />
          Dismiss all {n}
        </Button>
      </div>
    </li>
  );
}
