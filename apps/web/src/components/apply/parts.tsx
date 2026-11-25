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
import { jobNamedByLink, mergedSinceReview, namedAgainst } from '@opportun/core';
import { useNavigate } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatDateTime, type OpportunityView } from '@/lib/opportunities';
import {
  atsLabel,
  hostOf,
  isLive,
  submissionErrorText,
  useOpportunitySubmissions,
  useReviewSubmissionAgain,
  type SubmissionView,
} from './api';

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

/**
 * The promise, visible from the first step to the last (design (a) 3). `host` is empty while the
 * posting is not recognised: there is no site to name yet (#893).
 */
export function WillNotSubmitCallout({ host }: { host: string }) {
  return (
    <p
      role="note"
      className="flex items-start gap-2 rounded-md border-l-4 border-primary bg-accent px-3 py-2 text-sm text-accent-foreground"
    >
      <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>
        Opportun will not submit this. You will press the submit button on{' '}
        {host === '' ? (
          'the application site'
        ) : (
          <span className="font-mono [overflow-wrap:anywhere]">{host}</span>
        )}{' '}
        yourself.
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
  label,
}: {
  children: ReactNode;
  role?: 'status' | 'alert';
  id?: string;
  tabIndex?: number;
  /** An accessible name, when the notice needs one of its own. */
  label?: string;
}) {
  return (
    <div
      role={role}
      id={id}
      aria-label={label}
      tabIndex={tabIndex}
      className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="grid gap-1">{children}</div>
    </div>
  );
}

/**
 * Whether the opportunity's posting now names another job than the one this attempt was started
 * for (#144): its identity, else the job its link names. An attempt is always created with the
 * opportunity's identity, so any difference is a change, recorded or not: a change landing during
 * a create finds no attempt to mark yet (tl on #154). One that names no job has lost it, unless a
 * merge is why: then nothing changed, and the merge's notice says where it goes (#1057). The attempt
 * keeps its pinned destination; this is what the screens say.
 */
export function postingMoved(
  live: Pick<
    SubmissionView,
    'atsKind' | 'atsRef' | 'atsExternalId' | 'mergedAt' | 'reviewedAt' | 'postingChangedAt'
  >,
  opp: Pick<OpportunityView, 'atsJobRef' | 'postingUrl'>,
): boolean {
  const named = namedAgainst(
    { atsJobRef: opp.atsJobRef, postingUrl: opp.postingUrl ?? null },
    live,
  );
  if (named !== 'none') return named === 'another';
  return !(mergedSinceReview(live) && live.postingChangedAt == null);
}

const requisitionOf = (live: SubmissionView): string =>
  `${hostOf(live.destinationUrl)}, REQ ${live.atsExternalId}`;

/**
 * Opened on the employer's site, and what was reviewed is no longer what it is (#1057): the extension
 * does not fill it. `children` says what to do, where it is shown.
 */
export function ReviewLapsedNotice({
  live,
  children,
}: {
  live: SubmissionView;
  children: ReactNode;
}) {
  return (
    <Notice>
      <span>
        {mergedSinceReview(live) ? (
          <>
            <strong>Its opportunity was merged into this one after you opened it.</strong> The
            extension no longer fills it, as what you reviewed was for the merged one.
          </>
        ) : (
          <>
            <strong>Your review no longer holds.</strong> The extension no longer fills it.
          </>
        )}{' '}
        It still goes to {requisitionOf(live)}. {children}
      </span>
    </Notice>
  );
}

/**
 * What a merge does to the live application of the opportunity that goes (#1057). Nothing where there is
 * none, or assisted apply is off.
 */
export function MergeMovesApplication({ opportunityId }: { opportunityId: string }) {
  const live = useOpportunitySubmissions(opportunityId).data?.items.find(isLive);
  if (live === undefined) return null;
  return (
    <p className="basis-full text-sm">
      {live.status === 'handed_off'
        ? `Its application is open on ${hostOf(live.destinationUrl)}. It moves too, but the extension will no longer fill it: finish it and record it first, or review it again afterwards.`
        : `Its application to ${atsLabel(live.atsKind)} moves too, and has to be reviewed again.`}
    </p>
  );
}

/** A draft whose opportunity was merged into this one, until it is reviewed (#1057). */
export function MergedDraftNotice({ live }: { live: SubmissionView }) {
  if (live.status !== 'draft' || !mergedSinceReview(live)) return null;
  return (
    <Notice>
      <span>
        <strong>Its opportunity was merged into this one.</strong> Check everything, then review it
        again.
      </span>
    </Notice>
  );
}

/** A draft that was opened on the employer's site before: it may have been sent (#1057, sec). */
export function OpenedOnceNotice({ live }: { live: SubmissionView }) {
  if (live.status !== 'draft' || live.handedOffAt == null) return null;
  return (
    <Notice>
      <span>
        You opened this application on {formatDateTime(live.handedOffAt)}. If you submitted it then,
        don&apos;t send it again.
      </span>
    </Notice>
  );
}

/** Asks first: one that was submitted is said to be, not reviewed again (#1057). */
export function ReviewItAgain({
  live,
  opportunityId,
}: {
  live: SubmissionView;
  opportunityId: string;
}) {
  const navigate = useNavigate();
  const again = useReviewSubmissionAgain(opportunityId);
  const [asking, setAsking] = useState(false);
  return (
    <>
      <Button variant="outline" className="w-fit" onClick={() => setAsking(true)}>
        Review it again
      </Button>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title="Review this application again?"
        description="If you have already submitted it, press I submitted it instead."
        confirmLabel="Review it again"
        confirmVariant="default"
        onConfirm={async () => {
          let draft: SubmissionView;
          try {
            draft = await again.mutateAsync(live.id);
          } catch (err) {
            throw new Error(submissionErrorText(err), { cause: err });
          }
          await navigate({
            to: '/opportunities/$id/apply',
            params: { id: draft.opportunityId },
            search: { step: 'review' },
          });
        }}
      />
    </>
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
  const linked = ref == null && opp.postingUrl != null ? jobNamedByLink(opp.postingUrl) : null;
  const now =
    ref != null
      ? `${hostOf(ref.url)}, REQ ${ref.externalId}`
      : // A board's own page names its job, confirmed or not.
        linked !== null && linked.org !== null && opp.postingUrl != null
        ? `${hostOf(opp.postingUrl)}, REQ ${linked.externalId}`
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
