// The resume flow on an opportunity's Resume tab (https://github.com/bgoleno/opportun/issues/440,
// slice 2 of #400, tl's design note https://github.com/bgoleno/opportun/issues/400#issuecomment-6793581505
// and rulings https://github.com/bgoleno/opportun/issues/440#issuecomment-6805280758).
//
// Four steps, 1 Base, 2 Tailor, 3 Finish, 4 Apply, with the state read from real data by
// `resumeFlowState` (#428), the same function the Assisted apply panel asks, so the two cannot
// disagree. One filled button, the next action; a quiet second action under it. After an action
// here, focus moves to the new state's sentence and a polite live region says it.
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  applyBlockedReason,
  attemptPlace,
  isEmbeddedGreenhouseReason,
} from '@/components/apply/ApplyPanel';
import { atsLabel, useOpportunitySubmissions, type SubmissionView } from '@/components/apply/api';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { formatDate, type OpportunityView } from '@/lib/opportunities';
import { cn } from '@/lib/utils';
import {
  resumeErrorMessage,
  useCreateResume,
  useMatchReport,
  useOpportunitySends,
  useResumes,
  useScoreMatch,
  useScoringMatch,
  useUpdateResume,
  type Resume,
  type ResumeSend,
} from './api';
import { GoogleConnectHint, RegisterDocCard, StatusBadge } from './ResumeList';
import { RecordSendFields } from './ResumeSends';
import { resumeFlowState, type ResumeFlowState } from './resumeFlow';

export type Step = 1 | 2 | 3 | 4 | 'done';

const STEP_LABELS = ['Base', 'Tailor', 'Finish', 'Apply'] as const;

/**
 * The flow's data and state for one opportunity. `state` is undefined while it loads, and when a
 * list failed to load: `error` then holds the failure (tl on #443, blocking 2). An empty fallback
 * would read as "no resumes" or "nothing sent" and claim a state, with its primary action, that
 * nobody knows. A 404 on attempts is not an error: it is `null`, assisted apply unavailable.
 */
export function useResumeFlow(opp: OpportunityView) {
  const all = useResumes();
  const sends = useOpportunitySends(opp.id);
  const submissions = useOpportunitySubmissions(opp.id);
  // Only a failure with nothing loaded: a refetch that fails after a load keeps the data it had,
  // which is real, if not the newest.
  const failedLoad = (q: { error: unknown; data: unknown }) =>
    q.error !== null && q.data === undefined ? q.error : null;
  const error = failedLoad(all) ?? failedLoad(sends) ?? failedLoad(submissions);
  const loading = error !== null || all.isPending || sends.isPending || submissions.isPending;
  const resumes = all.data?.items ?? [];
  const sendItems = sends.data?.items ?? [];
  // null (or no answer): assisted apply is not available here, and nothing of it shows (#117).
  const assisted = submissions.data !== null && submissions.data !== undefined;
  const attempts = submissions.data?.items ?? [];
  const state = loading
    ? undefined
    : resumeFlowState({
        opportunityId: opp.id,
        resumes,
        sends: sendItems,
        attempts,
        applyBlocked: applyBlockedReason(opp),
        ...(assisted ? {} : { assistedApply: 'unavailable' as const }),
      });
  return { state, error, resumes, sends: sendItems, assisted };
}

/** The steps, the current one outlined and named, ApplyStepper's look (#400 note). Shared
 *  with the resume page's strip (#447). */
export function FlowSteps({ current }: { current: Step }) {
  const at = current === 'done' ? STEP_LABELS.length + 1 : current;
  return (
    <>
      <ol aria-label="Resume steps" className="hidden flex-wrap items-center gap-2 text-sm sm:flex">
        {STEP_LABELS.map((label, i) => (
          <li
            key={label}
            aria-current={i + 1 === at ? 'step' : undefined}
            className={cn(
              'rounded-full border px-3 py-1',
              i + 1 === at
                ? 'border-primary font-medium text-foreground'
                : 'border-border text-muted-foreground',
            )}
          >
            {i + 1} {label}
            {i + 1 < at ? <span className="sr-only"> (completed)</span> : null}
          </li>
        ))}
      </ol>
      {/* Phone width: one short line in place of the four (#400 note). */}
      <p className="text-sm text-muted-foreground sm:hidden">
        {current === 'done'
          ? 'All four steps done'
          : `Step ${current} of 4: ${STEP_LABELS[current - 1]}`}
      </p>
    </>
  );
}

export const primaryClass = 'w-full sm:w-fit';
// overflow-wrap anywhere, not break-words, wherever a copy's title can appear (#486): a title is
// often one long token (Name-Company-role_slug), and break-words does not lower a grid item's
// min-content width, so at 375 px it widened the whole tab.
export const quietClass =
  'w-fit text-left text-sm text-primary [overflow-wrap:anywhere] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** A quiet second action: a text button under the primary one. Disabled while its request is
 *  out, as the filled one is (tl on #443, blocking 3). */
export function Quiet({
  onClick,
  disabled = false,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn(quietClass, 'disabled:cursor-not-allowed disabled:opacity-50')}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

/** What one view of the flow shows: its step, its sentence, and what is under it. */
interface View {
  /** Changes when the user's place changes, so focus and the live region can follow. */
  key: string;
  step: Step;
  sentence: string;
  /** What the live region says after an action leads here. */
  next: string;
  body: ReactNode;
}

/** The base for "Tailor again" (tl on #440, ruling 6). */
function tailorAgainBase(
  resumes: readonly Resume[],
  sends: readonly ResumeSend[],
  opportunityId: string,
): Resume | undefined {
  const bases = resumes.filter((r) => r.kind === 'base' && r.archivedAt === null);
  const newest = resumes
    .filter((r) => r.kind === 'tailored' && r.opportunityId === opportunityId)
    .reduce<Resume | undefined>(
      (n, r) => (n === undefined || r.createdAt > n.createdAt ? r : n),
      undefined,
    );
  return (
    bases.find((b) => b.id === newest?.parentResumeId) ??
    bases.find((b) => sends.some((s) => s.resumeId === b.id)) ??
    bases[0]
  );
}

/** "Sent: <title> via <where> on <date>." for state H. */
export function sentSentence(state: Extract<ResumeFlowState, { state: 'H' }>): string {
  if (state.send !== undefined) {
    return `Sent: ${state.send.resumeTitle} via ${state.send.sentVia} on ${formatDate(state.send.sentAt)}.`;
  }
  if (state.attempt !== undefined) return appliedSentence(state.attempt);
  const r = state.resume;
  if (r === undefined) return 'Sent.';
  const to = r.submittedTo ? ` to ${r.submittedTo}` : '';
  const on = r.submittedAt === null ? '' : ` on ${formatDate(r.submittedAt)}`;
  return `Sent: ${r.title}${to}${on}.`;
}

function appliedSentence(a: SubmissionView): string {
  const on = a.submittedAt === null ? '' : ` on ${formatDate(a.submittedAt)}`;
  return `Sent: ${a.resumeTitle} through ${atsLabel(a.atsKind)}${on}.`;
}

/** What the live region says after an action leads to each state; the strip says the same. */
export const NEXT: Record<ResumeFlowState['state'], string> = {
  A: 'Next: add a base resume.',
  B: 'Next: create a tailored copy.',
  C: 'Next: tailor it.',
  D: 'Next: mark it as final.',
  E: 'Next: apply.',
  F: 'Next: record that you sent it.',
  G: 'Next: continue your application.',
  H: 'Nothing more to do here.',
};

export function ResumeFlowCard({
  opp,
  flow,
  onOpenOther,
}: {
  opp: OpportunityView;
  flow: ReturnType<typeof useResumeFlow>;
  /** Opens "Other ways to add a resume" and moves focus there (A's quiet action). */
  onOpenOther: () => void;
}) {
  const titleId = useId();
  const sentenceRef = useRef<HTMLHeadingElement>(null);
  // What an action here did ("Marked final."), until the view it leads to is shown.
  const done = useRef<string | null>(null);
  const [announced, setAnnounced] = useState('');

  const [asIs, setAsIs] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [recording, setRecording] = useState(false);
  const [chosenBase, setChosenBase] = useState('');

  // Set as an action starts, not when it succeeds: a mutation's own refresh can show the new place
  // before its success callback runs, and the change of place is what moves focus. Cleared if it
  // fails, so a later change is not announced as this action's.
  function startAction(what: string) {
    done.current = what;
  }
  function actionFailed() {
    done.current = null;
  }
  const recordSend = {
    onStart: () => startAction('Recorded as sent.'),
    onFail: actionFailed,
  };

  const view = flow.state === undefined ? undefined : viewFor(flow.state);

  useEffect(() => {
    // A form opened in one place is not carried into the next.
    setRecording(false);
    setRegistering(false);
    if (view === undefined || done.current === null) return;
    setAnnounced(`${done.current} ${view.next}`);
    done.current = null;
    sentenceRef.current?.focus();
    // Only a change of place moves focus, never a re-render in the same place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.key]);

  function viewFor(state: ResumeFlowState): View {
    const ats = atsLabel(opp.atsJobRef?.kind ?? '');
    const bases = flow.resumes.filter((r) => r.kind === 'base' && r.archivedAt === null);
    const baseId = chosenBase || bases[0]?.id || '';
    const base = bases.find((b) => b.id === baseId);
    switch (state.state) {
      case 'A':
        return {
          key: 'A',
          step: 1,
          sentence: 'Add a base resume to start.',
          next: NEXT.A,
          body: (
            <>
              {registering ? (
                <RegisterDocCard
                  onStart={() => startAction('Base resume registered.')}
                  onFail={actionFailed}
                />
              ) : (
                <Button className={primaryClass} onClick={() => setRegistering(true)}>
                  Register a base resume
                </Button>
              )}
              <Quiet onClick={onOpenOther}>Attach a resume you already tailored</Quiet>
            </>
          ),
        };
      case 'B':
        if (asIs && base !== undefined) return asIsView(base, bases, ats);
        return {
          key: 'B',
          step: 1,
          sentence: 'Choose the resume to start from.',
          next: NEXT.B,
          body: (
            <>
              <GoogleConnectHint />
              <BasePicker bases={bases} value={baseId} onChange={setChosenBase} />
              <CreateCopyButton
                baseId={baseId}
                opportunityId={opp.id}
                label="Create tailored copy"
              />
              <Quiet
                onClick={() => {
                  // A change of place, so focus and the live region follow it (qa's F1 on #443).
                  if (base !== undefined) startAction(`Sending ${base.title} as it is.`);
                  setAsIs(true);
                }}
              >
                Send a base resume as it is
              </Quiet>
            </>
          ),
        };
      case 'C':
        return {
          key: `C-${state.resume.id}`,
          step: 2,
          sentence: `Tailor "${state.resume.title}" for this role.`,
          next: NEXT.C,
          body: (
            <>
              <Button asChild className={primaryClass}>
                <Link to="/resumes/$id" params={{ id: state.resume.id }}>
                  Open and tailor
                </Link>
              </Button>
              <MarkFinal resume={state.resume} onStart={startAction} onFail={actionFailed} quiet>
                It needs no changes: mark as final
              </MarkFinal>
            </>
          ),
        };
      case 'D':
        return {
          key: `D-${state.resume.id}`,
          step: 3,
          sentence: 'Finished tailoring?',
          next: NEXT.D,
          body: (
            <>
              <ResumeLine resume={state.resume} opportunityId={opp.id} />
              <MarkFinal resume={state.resume} onStart={startAction} onFail={actionFailed}>
                Mark as final
              </MarkFinal>
              <Link className={quietClass} to="/resumes/$id" params={{ id: state.resume.id }}>
                Keep tailoring
              </Link>
            </>
          ),
        };
      case 'E':
        return {
          key: `E-${state.resume.id}`,
          step: 4,
          sentence: 'Ready to apply.',
          next: NEXT.E,
          body: (
            <ApplyOrRecord
              opp={opp}
              ats={ats}
              resume={state.resume}
              recording={recording}
              onRecord={() => setRecording(true)}
              recordSend={recordSend}
            />
          ),
        };
      case 'F': {
        const reason = 'reason' in state ? state.reason : null;
        return {
          key: `F-${state.resume.id}`,
          step: 4,
          sentence: reason ?? 'Ready to send.',
          next: NEXT.F,
          body: (
            <>
              {recording ? (
                <RecordSendFields {...recordSend} opportunityId={opp.id} resume={state.resume} />
              ) : (
                <Button className={primaryClass} onClick={() => setRecording(true)}>
                  Record that you sent it
                </Button>
              )}
              {reason === null ? null : <ReasonLink reason={reason} opportunityId={opp.id} />}
            </>
          ),
        };
      }
      case 'G': {
        const place = attemptPlace(state.attempt, atsLabel(state.attempt.atsKind));
        return {
          key: `G-${state.attempt.id}-${state.attempt.status}`,
          step: 4,
          sentence: place.text,
          next: NEXT.G,
          body: (
            <Button asChild className={primaryClass}>
              <Link
                to="/opportunities/$id/apply"
                params={{ id: opp.id }}
                search={{ step: place.step }}
              >
                Continue your application
              </Link>
            </Button>
          ),
        };
      }
      case 'H': {
        // No filled button: nothing is owed once an application is out (tl on #440, ruling 6).
        const again = state.again;
        const from = tailorAgainBase(flow.resumes, flow.sends, opp.id);
        return {
          key: `H-${again?.id ?? ''}-${again?.status ?? ''}`,
          step: 'done',
          sentence: sentSentence(state),
          next: NEXT.H,
          body:
            again !== undefined && again.status !== 'final' ? (
              <Link className={quietClass} to="/resumes/$id" params={{ id: again.id }}>
                Continue tailoring {again.title}
              </Link>
            ) : again !== undefined ? (
              recording ? (
                <RecordSendFields {...recordSend} opportunityId={opp.id} resume={again} quiet />
              ) : (
                <Quiet onClick={() => setRecording(true)}>Record that you sent {again.title}</Quiet>
              )
            ) : from !== undefined ? (
              <TailorAgain base={from} opportunityId={opp.id} />
            ) : null,
        };
      }
    }
  }

  /** The base-as-is branch of B (#400 note, tl on #440, ruling 4): nothing is stored but the
   *  base's status and a send. */
  function asIsView(base: Resume, bases: Resume[], ats: string): View {
    const usable = base.status === 'final' || base.status === 'submitted';
    const leave = (
      <Quiet
        onClick={() => {
          startAction('Back to choosing a resume.');
          setAsIs(false);
        }}
      >
        Tailor a copy instead
      </Quiet>
    );
    const picker = <BasePicker bases={bases} value={base.id} onChange={setChosenBase} />;
    if (!usable) {
      return {
        key: `B-asis-${base.id}-${base.status}`,
        step: 3,
        sentence: 'Send a base resume as it is.',
        next: NEXT.D,
        body: (
          <>
            {picker}
            <p className="text-sm text-muted-foreground">
              This marks {base.title} as final everywhere it is used.
            </p>
            <MarkFinal resume={base} onStart={startAction} onFail={actionFailed}>
              Mark {base.title} as final
            </MarkFinal>
            {leave}
          </>
        ),
      };
    }
    const blocked = flow.assisted ? applyBlockedReason(opp) : null;
    const canApply = flow.assisted && blocked === null;
    return {
      key: `B-asis-${base.id}-usable`,
      step: 4,
      sentence: canApply ? 'Ready to apply.' : (blocked ?? 'Ready to send.'),
      next: canApply ? NEXT.E : NEXT.F,
      body: (
        <>
          {picker}
          {canApply ? (
            <ApplyOrRecord
              opp={opp}
              ats={ats}
              resume={base}
              recording={recording}
              onRecord={() => setRecording(true)}
              recordSend={recordSend}
            />
          ) : recording ? (
            <RecordSendFields {...recordSend} opportunityId={opp.id} resume={base} />
          ) : (
            <Button className={primaryClass} onClick={() => setRecording(true)}>
              Record that you sent it
            </Button>
          )}
          {blocked === null ? null : <ReasonLink reason={blocked} opportunityId={opp.id} />}
          {leave}
        </>
      ),
    };
  }

  return (
    <Card role="region" aria-labelledby={titleId}>
      <CardHeader>
        <CardTitle id={titleId}>Resume for this application</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {flow.error !== null ? (
          <FormError message={`Could not load this resume flow: ${errorMessage(flow.error)}`} />
        ) : view === undefined ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <>
            <FlowSteps current={view.step} />
            <h3
              ref={sentenceRef}
              tabIndex={-1}
              className="text-base font-medium [overflow-wrap:anywhere] outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {view.sentence}
            </h3>
            <div className="grid gap-3">{view.body}</div>
          </>
        )}
        <p role="status" aria-live="polite" className="sr-only">
          {announced}
        </p>
      </CardContent>
    </Card>
  );
}

function BasePicker({
  bases,
  value,
  onChange,
}: {
  bases: Resume[];
  value: string;
  onChange: (id: string) => void;
}) {
  const id = useId();
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>Base resume</Label>
      <Select id={id} value={value} onChange={(e) => onChange(e.currentTarget.value)}>
        {bases.map((b) => (
          <option key={b.id} value={b.id}>
            {b.title}
          </option>
        ))}
      </Select>
    </div>
  );
}

/** Copies a base next to it for this opportunity, then opens the copy (#70). */
function CreateCopyButton({
  baseId,
  opportunityId,
  label,
  quiet = false,
}: {
  baseId: string;
  opportunityId: string;
  label: string;
  quiet?: boolean;
}) {
  const create = useCreateResume();
  const navigate = useNavigate();
  // Set in the click itself (#484): `disabled` follows isPending, which is not yet true when a
  // second click lands in the same tick, so two clicks with no gap made two copies. Released
  // when the request settles, so a click after a failure still sends.
  const sending = useRef(false);
  function createCopy() {
    if (baseId === '' || sending.current) return;
    sending.current = true;
    // The promise, not a callback given to mutate: the copy's arrival refreshes the resume
    // lists, and the flow moves on to C, unmounting this button, before the last list lands.
    // The query library skips an unmounted caller's own callbacks, so the page never opened
    // (#443's e2e). A failure shows through `create.error` while the button is still here.
    create
      .mutateAsync({ baseResumeId: baseId, opportunityId })
      .then((r) => navigate({ to: '/resumes/$id', params: { id: r.id } }))
      .catch(() => {})
      .finally(() => {
        sending.current = false;
      });
  }
  return (
    <>
      {create.error ? (
        <FormError message={resumeErrorMessage(create.error) ?? errorMessage(create.error)} />
      ) : null}
      {quiet ? (
        <Quiet onClick={createCopy} disabled={create.isPending}>
          {create.isPending ? 'Copying...' : label}
        </Quiet>
      ) : (
        <Button className={primaryClass} onClick={createCopy} disabled={create.isPending}>
          {create.isPending ? 'Copying...' : label}
        </Button>
      )}
    </>
  );
}

/** H's quiet action when no copy here has gone nowhere yet: a new copy of a base, named
 *  (ruling 6). */
function TailorAgain({ base, opportunityId }: { base: Resume; opportunityId: string }) {
  return (
    <div className="grid gap-1">
      <CreateCopyButton
        baseId={base.id}
        opportunityId={opportunityId}
        label="Tailor again for this opportunity"
        quiet
      />
      <p className="text-sm text-muted-foreground">Starts a new copy of {base.title}.</p>
    </div>
  );
}

/**
 * Marks a resume Final with the existing update. The button keeps the action's name, the toast
 * says "Marked final" and the badge "Final" (#400 note); a refusal says why here, in the flow.
 */
export function MarkFinal({
  resume,
  onStart,
  onFail,
  quiet = false,
  children,
}: {
  resume: Resume;
  onStart: (what: string) => void;
  onFail: () => void;
  quiet?: boolean;
  children: ReactNode;
}) {
  const update = useUpdateResume(resume.id);
  function mark() {
    onStart('Marked final.');
    // The promise, as in CreateCopyButton: the flow moves on to E, and this button is gone,
    // before the last refreshed list lands, so a callback given to mutate would be skipped.
    update
      .mutateAsync({ status: 'final' })
      .then(
        () => toast({ title: 'Marked final', description: resume.title, variant: 'success' }),
        onFail,
      );
  }
  return (
    <>
      {update.error ? (
        <FormError message={resumeErrorMessage(update.error) ?? errorMessage(update.error)} />
      ) : null}
      {quiet ? (
        <Quiet onClick={mark} disabled={update.isPending}>
          {children}
        </Quiet>
      ) : (
        <Button className={primaryClass} onClick={mark} disabled={update.isPending}>
          {children}
        </Button>
      )}
    </>
  );
}

/** D's line: the resume, its status, and its match score with "Score again" (#175). */
function ResumeLine({ resume, opportunityId }: { resume: Resume; opportunityId: string }) {
  const match = useMatchReport(resume.id, opportunityId);
  const m = match.data;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      <span className="font-medium [overflow-wrap:anywhere]">{resume.title}</span>
      <StatusBadge status={resume.status} />
      {m === null || m === undefined ? null : (
        <span className="text-muted-foreground">
          {`Match ${m.report.score}, ${formatDate(m.scoredAt)}`}
          {m.stale ? ' (before the last tailoring)' : ''}
        </span>
      )}
      <ScoreAgain resumeId={resume.id} opportunityId={opportunityId} />
    </div>
  );
}

/**
 * "Score again", disabled while any scoring of this resume is out, whichever button sent it
 * (tl on #447, ruling 3): the resume page also has the match report's own button.
 */
export function ScoreAgain({
  resumeId,
  opportunityId,
}: {
  resumeId: string;
  opportunityId: string;
}) {
  const score = useScoreMatch(resumeId);
  const scoring = useScoringMatch(resumeId);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={scoring}
        onClick={() => score.mutate(opportunityId)}
      >
        {scoring ? 'Scoring...' : 'Score again'}
      </Button>
      {score.error ? (
        <FormError message={resumeErrorMessage(score.error) ?? errorMessage(score.error)} />
      ) : null}
    </>
  );
}

/** Step 4 when assisted apply can start: Apply on <ATS>, or record a send instead. */
function ApplyOrRecord({
  opp,
  ats,
  resume,
  recording,
  onRecord,
  recordSend,
}: {
  opp: OpportunityView;
  ats: string;
  resume: Resume;
  recording: boolean;
  onRecord: () => void;
  recordSend: { onStart: () => void; onFail: () => void };
}) {
  return (
    <>
      <Button asChild className={primaryClass}>
        <Link to="/opportunities/$id/apply" params={{ id: opp.id }} search={{ step: 'resume' }}>
          Apply on {ats}
        </Link>
      </Button>
      {recording ? (
        <RecordSendFields {...recordSend} opportunityId={opp.id} resume={resume} quiet />
      ) : (
        <Quiet onClick={onRecord}>Record that you sent it yourself</Quiet>
      )}
    </>
  );
}

/** F's quiet link: where the reason says to go (tl on #440, ruling 5). A stage reason has
 *  none: the stage control is in the header on every tab. */
function ReasonLink({ reason, opportunityId }: { reason: string; opportunityId: string }) {
  if (isEmbeddedGreenhouseReason(reason)) {
    return (
      <Link className={quietClass} to="/opportunities/$id" params={{ id: opportunityId }}>
        Find posting on the Timeline tab
      </Link>
    );
  }
  if (reason.includes('Details tab')) {
    return (
      <Link
        className={quietClass}
        to="/opportunities/$id"
        params={{ id: opportunityId }}
        search={{ tab: 'details' }}
      >
        Open the Details tab
      </Link>
    );
  }
  return null;
}
