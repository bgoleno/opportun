// Small shared pieces of the apply screens (design Part B (d), (i)): the status chip, the
// "Opportun will not submit this" callout, the stepper and the amber notice. Existing components
// and tokens only.
import {
  AlertTriangle,
  Archive,
  Ban,
  Check,
  CheckCheck,
  CircleHelp,
  ClipboardCheck,
  ExternalLink,
  OctagonX,
  Pencil,
  ShieldCheck,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { OpportunityView } from '@/lib/opportunities';
import { hostOf, type SubmissionView } from './api';

type BadgeVariant = 'default' | 'secondary' | 'outline' | 'success' | 'warning' | 'destructive';

interface Chip {
  text: string;
  variant: BadgeVariant;
  Icon: typeof Pencil;
  dashed?: boolean;
}

const DRAFT_CHIP: Chip = { text: 'Draft', variant: 'outline', Icon: Pencil };
const CHIPS = new Map<string, Chip>([
  ['draft', DRAFT_CHIP],
  ['reviewed', { text: 'Reviewed', variant: 'secondary', Icon: ClipboardCheck }],
  ['handed_off', { text: 'Opened on ATS', variant: 'secondary', Icon: ExternalLink }],
  ['submitted', { text: 'Submitted', variant: 'default', Icon: Check }],
  ['confirmed', { text: 'Confirmed', variant: 'success', Icon: CheckCheck }],
  ['unknown', { text: 'No confirmation seen', variant: 'warning', Icon: CircleHelp }],
  ['rejected', { text: 'ATS refused', variant: 'destructive', Icon: Ban }],
  ['failed', { text: 'Failed', variant: 'destructive', Icon: OctagonX }],
  ['abandoned', { text: 'Abandoned', variant: 'outline', Icon: Archive, dashed: true }],
]);

/** Words and an icon for every status, never colour alone (design (d)). */
export function SubmissionStatusChip({ status }: { status: string }) {
  const chip = CHIPS.get(status) ?? DRAFT_CHIP;
  const { Icon } = chip;
  return (
    <Badge variant={chip.variant} className={cn('gap-1', chip.dashed && 'border-dashed')}>
      <span className="sr-only">Submission status: </span>
      <Icon className="size-3" aria-hidden="true" />
      {chip.text}
    </Badge>
  );
}

/** The promise, visible from the first step to the last (design (a) 3). */
export function WillNotSubmitCallout({ host }: { host: string }) {
  return (
    <p
      role="note"
      className="flex items-start gap-2 rounded-md border-l-4 border-primary bg-accent px-3 py-2 text-sm text-accent-foreground"
    >
      <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>
        Opportun will not submit this. You will press the submit button on{' '}
        <span className="font-mono [overflow-wrap:anywhere]">{host}</span> yourself.
      </span>
    </p>
  );
}

export const STEPS = [
  { id: 'resume', label: 'Resume' },
  { id: 'details', label: 'Details' },
  { id: 'review', label: 'Review' },
  { id: 'open', label: 'Open' },
] as const;
export type StepId = (typeof STEPS)[number]['id'];

/** Where the user is, as an ordered list (design (g)): not a tablist, not a control. */
export function ApplyStepper({ current, openLabel }: { current: StepId; openLabel: string }) {
  const at = STEPS.findIndex((s) => s.id === current);
  return (
    <ol aria-label="Progress" className="flex flex-wrap items-center gap-2 text-sm">
      {STEPS.map((s, i) => {
        const label = s.id === 'open' ? openLabel : s.label;
        return (
          <li
            key={s.id}
            aria-current={i === at ? 'step' : undefined}
            className={cn(
              'rounded-full border px-3 py-1',
              i === at
                ? 'border-primary font-medium text-foreground'
                : 'border-border text-muted-foreground',
            )}
          >
            {i + 1} {label}
            {i < at ? <span className="sr-only"> (completed)</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

/** The amber notice used for things to notice (design (a) 6), PostingStateBanner's classes. */
export function Notice({
  children,
  role = 'status',
  id,
  tabIndex,
}: {
  children: ReactNode;
  role?: 'status' | 'alert';
  id?: string;
  tabIndex?: number;
}) {
  return (
    <div
      role={role}
      id={id}
      tabIndex={tabIndex}
      className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="grid gap-1">{children}</div>
    </div>
  );
}

/**
 * Whether the opportunity's posting changed under this attempt (#144) so that it now names
 * another job than the one the attempt was started for. The attempt keeps its pinned
 * destination; this is what the screens tell the user about.
 */
export function postingMoved(
  live: Pick<SubmissionView, 'postingChangedAt' | 'atsKind' | 'atsRef' | 'atsExternalId'>,
  opp: Pick<OpportunityView, 'atsJobRef'>,
): boolean {
  if (live.postingChangedAt == null) return false;
  const ref = opp.atsJobRef;
  return !(
    ref != null &&
    ref.kind === live.atsKind &&
    (ref.org ?? '').toLowerCase() === (live.atsRef ?? '').toLowerCase() &&
    ref.externalId === live.atsExternalId
  );
}

/**
 * "Started for <old host>, REQ <old id>; the posting is now <new>; cancel and start again to use
 * it" (#144, the owner's option A). Nothing is cancelled for the user, and their answers stay.
 */
export function PostingChangedNotice({
  live,
  opp,
}: {
  live: SubmissionView;
  opp: Pick<OpportunityView, 'atsJobRef' | 'postingUrl'>;
}) {
  const ref = opp.atsJobRef;
  const now =
    ref != null
      ? `${hostOf(ref.url)}, REQ ${ref.externalId}`
      : opp.postingUrl != null
        ? `${hostOf(opp.postingUrl)}, which is not an application site Opportun recognises`
        : 'no longer set';
  return (
    <Notice>
      <span>
        <strong>The posting changed after you started.</strong> This application was started for{' '}
        {hostOf(live.destinationUrl)}, REQ {live.atsExternalId}, and still goes there. The posting
        is now {now}. Your answers are kept. To apply to the new posting, cancel this application
        and start again.
      </span>
    </Notice>
  );
}
