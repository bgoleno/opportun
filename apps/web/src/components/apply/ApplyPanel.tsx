// S1, the Assisted apply card on the opportunity page (design Part B (c) S1,
// https://github.com/bgoleno/opportun/issues/117). One opportunity at a time: no queue, no
// "next opportunity", no counts framed as goals (design (a) 5).
//
// With the flag off, or on the demo, the submission routes answer 404 and this renders nothing
// at all: no card, no teaser (#117 criterion 5).
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useResumes, type Resume } from '@/components/resume/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatDateTime, stageLabel, type OpportunityView } from '@/lib/opportunities';
import {
  atsLabel,
  clockTime,
  isLive,
  useCancelSubmission,
  useOpportunitySubmissions,
  type SubmissionView,
} from './api';
import { PostingChangedNotice, postingMoved, SubmissionStatusChip } from './parts';

/** The stages an attempt may start at (the server's SUBMISSION_ELIGIBLE_STAGES). */
const ELIGIBLE_STAGES: readonly string[] = ['interested', 'preparing', 'applied'];

/** A finished resume this opportunity may use: final or already submitted, not archived. */
export function usableResumes(resumes: Resume[], opportunityId: string): Resume[] {
  return resumes.filter(
    (r) =>
      (r.status === 'final' || r.status === 'submitted') &&
      r.archivedAt === null &&
      (r.kind === 'base' || r.opportunityId === opportunityId),
  );
}

/** Why an attempt cannot start, in the user's words, or null when it can. */
function notEligible(opp: OpportunityView, resumes: Resume[]): string | null {
  if (opp.stage === 'closed' || opp.stage === 'dismissed') {
    return `This opportunity is ${stageLabel(opp.stage)}. Reopen it to apply.`;
  }
  if (!ELIGIBLE_STAGES.includes(opp.stage)) {
    return 'Applying is available at Interested, Preparing or Applied.';
  }
  if (opp.atsJobRef === null || opp.atsJobRef === undefined) {
    return "We have not recognised this company's application system yet. Open the posting from the Details tab, or use Find posting.";
  }
  if (opp.postingState !== 'confirmed') {
    return "This opportunity's posting needs review. Confirm it on the Details tab first.";
  }
  if (usableResumes(resumes, opp.id).length === 0) return 'Attach a final resume first.';
  return null;
}

export function ApplyPanel({ opp }: { opp: OpportunityView }) {
  const submissions = useOpportunitySubmissions(opp.id);
  const resumes = useResumes();
  const reasonId = useId();
  const [howOpen, setHowOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const cancel = useCancelSubmission(opp.id);

  // Feature off, on the demo, or not loaded: nothing of the feature shows.
  if (submissions.data === null || submissions.data === undefined) return null;
  const items = submissions.data.items;
  const live = items.find(isLive);
  const latest = items[0];
  const ats = atsLabel(live?.atsKind ?? opp.atsJobRef?.kind ?? '');

  let body: React.ReactNode;
  if (live !== undefined) {
    body = <InProgress live={live} opp={opp} ats={ats} onStop={() => setStopping(true)} />;
  } else {
    const reason = notEligible(opp, resumes.data?.items ?? []);
    body = (
      <div className="grid gap-3">
        {latest !== undefined ? <LastAttempt latest={latest} /> : null}
        <p className="text-sm text-muted-foreground">
          {reason ??
            'You will review everything, then fill in and submit the form on the ATS yourself.'}
        </p>
        {reason === null ? (
          <Button asChild className="w-full">
            <Link to="/opportunities/$id/apply" params={{ id: opp.id }} search={{ step: 'resume' }}>
              Apply on {ats}
            </Link>
          </Button>
        ) : (
          // aria-disabled, not disabled: still reachable by keyboard, with the reason announced
          // (design (g)).
          <Button
            className="w-full"
            aria-disabled="true"
            aria-describedby={reasonId}
            onClick={(e) => e.preventDefault()}
          >
            {opp.atsJobRef ? `Apply on ${ats}` : 'Apply on an ATS'}
          </Button>
        )}
        {reason !== null ? (
          <span id={reasonId} className="sr-only">
            {reason}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <Card role="region" aria-labelledby="assisted-apply-title">
      <CardHeader>
        <CardTitle id="assisted-apply-title" className="text-base">
          Assisted apply
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {body}
        <button
          type="button"
          className="w-fit text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setHowOpen(true)}
        >
          How this works
        </button>
      </CardContent>
      <HowItWorksDialog open={howOpen} onOpenChange={setHowOpen} />
      {live !== undefined ? (
        <ConfirmDialog
          open={stopping}
          onOpenChange={setStopping}
          title="Stop this application?"
          description="Nothing was submitted. You can start again later."
          confirmLabel="Stop application"
          onConfirm={async () => {
            await cancel.mutateAsync(live.id);
          }}
        />
      ) : null}
    </Card>
  );
}

function InProgress({
  live,
  opp,
  ats,
  onStop,
}: {
  live: SubmissionView;
  opp: OpportunityView;
  ats: string;
  onStop: () => void;
}) {
  const opportunityId = opp.id;
  const step = live.status === 'draft' ? 'details' : live.status === 'reviewed' ? 'review' : 'open';
  const text =
    live.status === 'draft'
      ? 'Your application is saved as a draft.'
      : live.status === 'reviewed'
        ? 'Your review is saved. Nothing has been sent anywhere.'
        : `Finish the form on ${ats} and press its own Submit button.`;
  const action =
    live.status === 'draft'
      ? 'Continue'
      : live.status === 'reviewed'
        ? `Continue to open ${ats}`
        : 'Instructions';
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <SubmissionStatusChip status={live.status} />
        {live.status === 'reviewed' && live.reviewExpiresAt !== null ? (
          <span className="text-xs text-muted-foreground">
            Review valid until {clockTime(live.reviewExpiresAt)}
          </span>
        ) : null}
        {live.status === 'handed_off' && live.handedOffAt !== null ? (
          <span className="text-xs text-muted-foreground">
            Opened {formatDateTime(live.handedOffAt)}
          </span>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">{text}</p>
      {/* The posting changed under the attempt (#144): say so where the user starts from. */}
      {postingMoved(live, opp) ? <PostingChangedNotice live={live} opp={opp} /> : null}
      <Button asChild className="w-full">
        <Link to="/opportunities/$id/apply" params={{ id: opportunityId }} search={{ step }}>
          {action}
        </Link>
      </Button>
      <button
        type="button"
        onClick={onStop}
        className="w-fit text-sm text-muted-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Cancel this application
      </button>
    </div>
  );
}

/** The most recent finished attempt, so a new one starts knowing about it. */
function LastAttempt({ latest }: { latest: SubmissionView }) {
  if (latest.status === 'abandoned' && latest.failureReason === 'review_expired') {
    return (
      <p className="text-sm text-muted-foreground">
        Your last review expired before the form was opened. Starting again keeps your details and
        answers.
      </p>
    );
  }
  if (['submitted', 'confirmed', 'unknown'].includes(latest.status)) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <SubmissionStatusChip status={latest.status} />
        {latest.submittedAt !== null ? (
          <span className="text-muted-foreground">{formatDateTime(latest.submittedAt)}</span>
        ) : null}
      </div>
    );
  }
  return null;
}

/** "How Assisted apply works" (design S1b). */
export function HowItWorksDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>How Assisted apply works</DialogTitle>
          <DialogDescription>
            Opportun cannot apply to a job for you, and does not try to. You do the applying,
            Opportun keeps the record.
          </DialogDescription>
        </DialogHeader>
        <ol className="grid list-decimal gap-1 pl-5 text-sm">
          <li>You choose a resume.</li>
          <li>You review everything on one screen.</li>
          <li>You open the real application form.</li>
          <li>You press that site&apos;s Submit button.</li>
          <li>You tell Opportun.</li>
        </ol>
        <p className="text-sm text-muted-foreground">
          Opportun never sends anything to the application site, never logs in there, and never
          applies to more than one job at a time.
        </p>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
