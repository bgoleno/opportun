// S1, the Assisted apply card on the opportunity page (design Part B (c) S1,
// https://github.com/bgoleno/opportun/issues/117). One opportunity at a time: no queue, no
// "next opportunity", no counts framed as goals (design (a) 5).
//
// With the flag off, or on the demo, the submission routes answer 404 and this renders nothing
// at all: no card, no teaser (#117 criterion 5).
import { greenhouseJidOf } from '@opportun/core';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useFindPosting, type FindPostingResult } from '@/components/opportunity/api';
import { statusLabel, useResumes, type Resume } from '@/components/resume/api';
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
import { ApiError, errorMessage } from '@/lib/api';
import { formatDate, formatDateTime, stageLabel, type OpportunityView } from '@/lib/opportunities';
import {
  atsLabel,
  clockTime,
  isLive,
  useCancelSubmission,
  useOpportunitySubmissions,
  type SubmissionView,
} from './api';
import { OutcomeActions, REPORTABLE } from './OutcomeActions';
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

/** What the panel says after Find posting, by its answer (#398). */
const FIND_SAID = new Map<FindPostingResult['outcome'], string>([
  ['attached', 'Posting attached.'],
  ['identified', 'Recognised on Greenhouse.'],
  ['candidates', 'Several postings could be this job. Choose it on the Details tab.'],
  ['none', "This job was not found on the company's board. Paste the posting on the Details tab."],
  [
    'no_board',
    'No job board is known for this company yet. Add its careers page on the Details tab.',
  ],
]);

/** Find posting offering exactly one posting to choose (tl on #414). */
const ONE_CANDIDATE =
  "A posting on the company's board could be this job. Check it on the Details tab.";

const NOT_ON_A_KNOWN_BOARD =
  'This job was not found on a Greenhouse board known for this company. Check the posting link on the Details tab.';

/** Find posting's 409 for a description the user wrote (the server found no board for the link). */
function isAlreadyDescribed(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'already_described';
}

const EMBEDDED_GREENHOUSE =
  "This looks like a Greenhouse job on the company's own careers page. Find the posting on Greenhouse to apply with assisted apply.";

/** A posting link with a numeric `gh_jid` and no ATS identity yet (#398). */
function embeddedGreenhouse(opp: OpportunityView): boolean {
  return (
    (opp.atsJobRef === null || opp.atsJobRef === undefined) &&
    greenhouseJidOf(opp.postingUrl) !== null
  );
}

/** Why an attempt cannot start, in the user's words, or null when it can. */
function notEligible(opp: OpportunityView, resumes: Resume[]): string | null {
  if (opp.stage === 'closed' || opp.stage === 'dismissed') {
    return `This opportunity is ${stageLabel(opp.stage)}. Reopen it to apply.`;
  }
  if (!ELIGIBLE_STAGES.includes(opp.stage)) {
    // Name the stage it is at, so the reason says what to change (#395).
    return `This opportunity is ${stageLabel(opp.stage)}. Applying is available at Interested, Preparing or Applied. Change its stage to apply.`;
  }
  if (opp.atsJobRef === null || opp.atsJobRef === undefined) {
    // A Greenhouse job on the company's own page (`?gh_jid=`) whose board is not proven yet
    // (#398): Find posting looks for it on the company's board, detecting the board first when
    // there is none, and the identity follows from that read.
    if (embeddedGreenhouse(opp)) return EMBEDDED_GREENHOUSE;
    return "We have not recognised this company's application system yet. Open the posting from the Details tab, or use Find posting.";
  }
  if (opp.postingState !== 'confirmed') {
    return "This opportunity's posting needs review. Confirm it on the Details tab first.";
  }
  if (usableResumes(resumes, opp.id).length === 0) {
    // A resume made for this opportunity that is not Final yet: "attach one" would mislead, so
    // say which one it is and what to change (#395).
    const attached = resumes.find(
      (r) => r.kind === 'tailored' && r.opportunityId === opp.id && r.archivedAt === null,
    );
    if (attached !== undefined) {
      return `The resume attached here ("${attached.title}") is ${statusLabel(attached.status)}. Open it from the Resume tab and set its Status to Final.`;
    }
    return 'Attach a final resume first.';
  }
  return null;
}

/** The statuses that mean the user has applied (#404): Submitted, Confirmed, No confirmation seen
 *  or Rejected. */
const APPLIED: readonly string[] = ['submitted', 'confirmed', 'unknown', 'rejected'];

/**
 * The application the panel leads with once the user has applied (#404, tl's decision 1): the
 * newest attempt that is Submitted, Confirmed, No confirmation seen or Rejected, whatever newer
 * attempt was cancelled or expired after it. `items` are newest first, as the server lists them.
 */
export function appliedAttempt(items: readonly SubmissionView[]): SubmissionView | undefined {
  return items.find((s) => APPLIED.includes(s.status));
}

export function ApplyPanel({ opp }: { opp: OpportunityView }) {
  const submissions = useOpportunitySubmissions(opp.id);
  const resumes = useResumes();
  const reasonId = useId();
  const find = useFindPosting(opp.id);
  const [howOpen, setHowOpen] = useState(false);
  // A click on the refused button (#395): it says so, rather than doing nothing. Kept as the
  // reason that was clicked, so a different reason later reads plainly until it is clicked too.
  const [clickedReason, setClickedReason] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const cancel = useCancelSubmission(opp.id);

  // Feature off, on the demo, or not loaded: nothing of the feature shows.
  if (submissions.data === null || submissions.data === undefined) return null;
  const items = submissions.data.items;
  const live = items.find(isLive);
  const latest = items[0];
  const ats = atsLabel(live?.atsKind ?? opp.atsJobRef?.kind ?? '');
  // The newest attempt the user can still report on (#148, tl's review): not only the newest
  // attempt. A re-application in progress, or a newer one cancelled or expired, must not leave
  // an earlier submission's follow-up unanswerable.
  const reportable = items.find((s) => REPORTABLE.includes(s.status));
  const reportableIsLast = live === undefined && reportable !== undefined && reportable === latest;

  // Once the user has applied and nothing is in progress, the outcome leads (#404).
  const outcome = live === undefined ? appliedAttempt(items) : undefined;

  let body: React.ReactNode;
  if (live !== undefined) {
    body = <InProgress live={live} opp={opp} ats={ats} onStop={() => setStopping(true)} />;
  } else if (outcome !== undefined) {
    body = (
      <Applied
        attempt={outcome}
        opp={opp}
        // Offered only when the server would accept a new attempt, so it never leads to a refusal.
        canApplyAgain={notEligible(opp, resumes.data?.items ?? []) === null}
      />
    );
  } else {
    const reason = notEligible(opp, resumes.data?.items ?? []);
    const refusedLabel = opp.atsJobRef ? `Apply on ${ats}` : 'Apply on an ATS';
    body = (
      <div className="grid gap-3">
        {latest !== undefined ? (
          <LastAttempt latest={latest} companyName={opp.companyName} />
        ) : null}
        {reason === null ? (
          <>
            <p className="text-sm text-muted-foreground">
              You will review everything, then fill in and submit the form on the ATS yourself.
            </p>
            <Button asChild className="w-full">
              <Link
                to="/opportunities/$id/apply"
                params={{ id: opp.id }}
                search={{ step: 'resume' }}
              >
                Apply on {ats}
              </Link>
            </Button>
          </>
        ) : (
          <>
            {/* aria-disabled, not disabled: still reachable by keyboard, with the reason announced
                (design (g)). The Button's own disabled: styles match only the disabled attribute,
                so it is dimmed here, or it looks like it would work (#395). */}
            <Button
              className="w-full aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-primary"
              aria-disabled="true"
              aria-describedby={reasonId}
              onClick={(e) => {
                e.preventDefault();
                setClickedReason(reason);
              }}
            >
              {refusedLabel}
            </Button>
            {/* The reason, visible and right after the button. A click says it again, so the
                click is answered and a screen reader hears it (polite live region). */}
            <p
              id={reasonId}
              aria-live="polite"
              className={
                clickedReason === reason
                  ? 'text-sm text-foreground'
                  : 'text-sm text-muted-foreground'
              }
            >
              {clickedReason === reason
                ? `${refusedLabel} is not available yet. ${reason}`
                : reason}
            </p>
            {reason === EMBEDDED_GREENHOUSE ? (
              <>
                <Button
                  variant="outline"
                  className="w-fit"
                  disabled={find.isPending}
                  onClick={() => find.mutate()}
                >
                  {find.isPending ? 'Searching...' : 'Find posting'}
                </Button>
                {/* What Find posting found, and where to go next: never a silent button
                    (#395, tl on #414). */}
                {find.isError && isAlreadyDescribed(find.error) ? (
                  // A description of the user's own, and no known board holds the job (#398):
                  // an answer, not a failure.
                  <p role="status" className="text-sm text-muted-foreground">
                    {NOT_ON_A_KNOWN_BOARD}
                  </p>
                ) : find.isError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {errorMessage(find.error)}
                  </p>
                ) : find.data !== undefined ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    {find.data.outcome === 'candidates' && find.data.candidates?.length === 1
                      ? ONE_CANDIDATE
                      : (FIND_SAID.get(find.data.outcome) ?? '')}
                  </p>
                ) : null}
              </>
            ) : null}
          </>
        )}
      </div>
    );
  }

  const earlierReport =
    reportable !== undefined && !reportableIsLast && reportable !== outcome ? (
      <EarlierAttempt attempt={reportable} companyName={opp.companyName} />
    ) : null;

  return (
    <Card role="region" aria-labelledby="assisted-apply-title">
      <CardHeader>
        <CardTitle id="assisted-apply-title" className="text-base">
          Assisted apply
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {body}
        {earlierReport}
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

/**
 * The panel once the user has applied (#404, tl's decision 1): the outcome, the application
 * itself as the filled button, the follow-up questions, and applying again as a quiet link under
 * one line of why. The apply flow it opens asks for the reason (owner decision 6).
 */
function Applied({
  attempt,
  opp,
  canApplyAgain,
}: {
  attempt: SubmissionView;
  opp: OpportunityView;
  canApplyAgain: boolean;
}) {
  const ats = atsLabel(attempt.atsKind);
  const when =
    attempt.submittedAt === null
      ? `You applied through ${ats}.`
      : `You applied on ${formatDate(attempt.submittedAt)} through ${ats}.`;
  const confirmed =
    attempt.status === 'confirmed' && attempt.confirmedAt !== null
      ? ` ${ats} confirmed it on ${formatDate(attempt.confirmedAt)}.`
      : '';
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <SubmissionStatusChip status={attempt.status} />
      </div>
      <p className="text-sm">{`${when}${confirmed}`}</p>
      <Button asChild className="w-full">
        <Link
          to="/opportunities/$id/applications/$submissionId"
          params={{ id: attempt.opportunityId, submissionId: attempt.id }}
        >
          View application
        </Link>
      </Button>
      <OutcomeActions attempt={attempt} companyName={opp.companyName} />
      {canApplyAgain ? (
        <div className="grid gap-1">
          <p className="text-sm text-muted-foreground">
            Apply again only if the first application did not go through, or the employer asked you
            to. You will be asked for the reason.
          </p>
          <Link
            to="/opportunities/$id/apply"
            params={{ id: opp.id }}
            search={{ step: 'resume' }}
            className="w-fit text-sm text-primary underline-offset-4 hover:underline"
          >
            Apply again
          </Link>
        </div>
      ) : null}
    </div>
  );
}

/** The most recent finished attempt, so a new one starts knowing about it. */
function LastAttempt({ latest, companyName }: { latest: SubmissionView; companyName: string }) {
  if (latest.status === 'abandoned' && latest.failureReason === 'review_expired') {
    return (
      <p className="text-sm text-muted-foreground">
        Your last review expired before the form was opened. Starting again keeps your details and
        answers.
      </p>
    );
  }
  if (['submitted', 'confirmed', 'unknown', 'rejected'].includes(latest.status)) {
    return (
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <SubmissionStatusChip status={latest.status} />
          {latest.submittedAt !== null ? (
            <span className="text-muted-foreground">{formatDateTime(latest.submittedAt)}</span>
          ) : null}
          <ViewApplication attempt={latest} />
        </div>
        {/* What happened after submitting (#148): for submitted or no confirmation seen. */}
        <OutcomeActions attempt={latest} companyName={companyName} />
      </div>
    );
  }
  return null;
}

/**
 * A submitted attempt the user can still report on, when it is not the newest one (a
 * re-application is in progress, or a newer attempt was cancelled or expired): named by when it
 * was submitted, so it is clear which application the answer is about.
 */
function EarlierAttempt({
  attempt,
  companyName,
}: {
  attempt: SubmissionView;
  companyName: string;
}) {
  return (
    <section aria-label="Earlier application" className="grid gap-3 border-t pt-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">
          Earlier application
          {attempt.submittedAt !== null ? `, submitted ${formatDateTime(attempt.submittedAt)}` : ''}
        </span>
        <SubmissionStatusChip status={attempt.status} />
        <ViewApplication attempt={attempt} />
      </div>
      <OutcomeActions attempt={attempt} companyName={companyName} />
    </section>
  );
}

/** The application's own page (design S7, #149): what was sent, its history and evidence. */
function ViewApplication({ attempt }: { attempt: SubmissionView }) {
  return (
    <Link
      to="/opportunities/$id/applications/$submissionId"
      params={{ id: attempt.opportunityId, submissionId: attempt.id }}
      className="text-primary underline-offset-4 hover:underline"
    >
      View application
    </Link>
  );
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
