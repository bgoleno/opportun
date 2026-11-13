// The next-step strip on a tailored resume's own page (https://github.com/bgoleno/opportun/issues/447,
// slice 3 of #400; tl's note https://github.com/bgoleno/opportun/issues/400#issuecomment-6793581505,
// "Where it lives", item 2, and rulings https://github.com/bgoleno/opportun/issues/447#issuecomment-6842084292).
//
// The same flow as the opportunity's Resume tab, from the same answer (useResumeFlow), with the
// same steps and words, and one action: "Mark as final" in place while the copy is being
// tailored, "Apply on <ATS>" once assisted apply can start, and otherwise the way back to the
// opportunity, where what is still owed happens.
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { attemptPlace } from '@/components/apply/ApplyPanel';
import { atsLabel } from '@/components/apply/api';
import { useOpportunity } from '@/components/opportunity/api';
import { FormError } from '@/components/FormError';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api';
import type { OpportunityView } from '@/lib/opportunities';
import type { Resume } from './api';
import {
  FlowSteps,
  MarkFinal,
  NEXT,
  primaryClass,
  quietClass,
  ScoreAgain,
  sentSentence,
  useResumeFlow,
  type Step,
} from './ResumeFlowCard';
import { opportunityResume, type ResumeFlowState } from './resumeFlow';

const LABEL = 'Next step for this resume';

/**
 * Shown on a tailored resume's page only (ResumeWorkspace decides). Nothing while the
 * opportunity loads, and nothing when it cannot be read (deleted, or a 404): the rest of the
 * page stays as it was (tl's ruling 2).
 */
export function ResumeFlowStrip({
  resume,
  opportunityId,
}: {
  resume: Resume;
  opportunityId: string;
}) {
  const opp = useOpportunity(opportunityId);
  if (opp.data === undefined) return null;
  return <StripLoaded resume={resume} opp={opp.data} />;
}

function StripLoaded({ resume, opp }: { resume: Resume; opp: OpportunityView }) {
  const flow = useResumeFlow(opp);
  const sentenceRef = useRef<HTMLHeadingElement>(null);
  // As on the tab: set as an action starts, cleared if it fails, said when the place changes.
  const done = useRef<string | null>(null);
  const [announced, setAnnounced] = useState('');

  const followed = opportunityResume(flow.resumes, opp.id);
  const mine = followed?.id === resume.id;
  const view = flow.state === undefined || !mine ? undefined : viewFor(flow.state);

  useEffect(() => {
    if (view === undefined || done.current === null) return;
    setAnnounced(`${done.current} ${view.next}`);
    done.current = null;
    sentenceRef.current?.focus();
    // Only a change of place moves focus, never a re-render in the same place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.key]);

  function viewFor(state: ResumeFlowState): {
    key: string;
    step: Step;
    sentence: string;
    next: string;
    action: ReactNode;
  } {
    const backLink = (className?: string) => (
      <Link
        to="/opportunities/$id"
        params={{ id: opp.id }}
        search={{ tab: 'resume' }}
        className={className}
      >
        Back to the opportunity
      </Link>
    );
    const back = (filled: boolean) =>
      filled ? (
        <Button asChild className={primaryClass}>
          {backLink()}
        </Button>
      ) : (
        backLink(quietClass)
      );
    const markFinal = (
      <div className="flex flex-wrap items-center gap-3">
        <MarkFinal
          resume={resume}
          onStart={(what) => {
            done.current = what;
          }}
          onFail={() => {
            done.current = null;
          }}
        >
          Mark as final
        </MarkFinal>
        <ScoreAgain resumeId={resume.id} opportunityId={opp.id} />
      </div>
    );
    switch (state.state) {
      case 'C':
        return {
          key: `C-${state.resume.id}`,
          step: 2,
          sentence: `Tailor "${state.resume.title}" for this role.`,
          next: NEXT.C,
          action: markFinal,
        };
      case 'D':
        return {
          key: `D-${state.resume.id}`,
          step: 3,
          sentence: 'Finished tailoring?',
          next: NEXT.D,
          action: markFinal,
        };
      case 'E':
        return {
          key: `E-${state.resume.id}`,
          step: 4,
          sentence: 'Ready to apply.',
          next: NEXT.E,
          action: (
            <Button asChild className={primaryClass}>
              <Link
                to="/opportunities/$id/apply"
                params={{ id: opp.id }}
                search={{ step: 'resume' }}
              >
                Apply on {atsLabel(opp.atsJobRef?.kind ?? '')}
              </Link>
            </Button>
          ),
        };
      // F and G: something is still owed, on the tab (recording the send, or continuing the
      // attempt), so the way there is the filled button (tl's ruling 1).
      case 'F':
        return {
          key: `F-${state.resume.id}`,
          step: 4,
          sentence: 'reason' in state ? state.reason : 'Ready to send.',
          next: NEXT.F,
          action: back(true),
        };
      case 'G':
        return {
          key: `G-${state.attempt.id}-${state.attempt.status}`,
          step: 4,
          sentence: attemptPlace(state.attempt, atsLabel(state.attempt.atsKind)).text,
          next: NEXT.G,
          action: back(true),
        };
      // H: nothing is owed once an application is out, so no filled button.
      case 'H':
        return {
          key: 'H',
          step: 'done',
          sentence: sentSentence(state),
          next: NEXT.H,
          action: back(false),
        };
      // A and B cannot be this copy's state: it is the opportunity's tailored copy.
      case 'A':
      case 'B':
        return { key: state.state, step: 1, sentence: '', next: NEXT[state.state], action: null };
    }
  }

  return (
    <section
      aria-label={LABEL}
      className="grid gap-3 rounded-xl border bg-card p-4 text-card-foreground shadow-sm"
    >
      <p className="text-sm text-muted-foreground">
        For {opp.title} at {opp.companyName}
      </p>
      {flow.error !== null ? (
        <FormError message={`Could not load this resume flow: ${errorMessage(flow.error)}`} />
      ) : flow.state === undefined ? null : !mine ? (
        <NotFollowed followed={followed} opportunityId={opp.id} />
      ) : view !== undefined ? (
        <>
          <FlowSteps current={view.step} />
          <h2
            ref={sentenceRef}
            tabIndex={-1}
            className="text-base font-medium break-words outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {view.sentence}
          </h2>
          {view.action}
        </>
      ) : null}
      <p role="status" aria-live="polite" className="sr-only">
        {announced}
      </p>
    </section>
  );
}

/**
 * This page's copy is not the one the flow follows (an older copy, or an archived one): no steps
 * and no action, which would be about a copy the flow ignores (ruling 2). Names the one it does
 * follow, or the opportunity when it follows none.
 */
function NotFollowed({
  followed,
  opportunityId,
}: {
  followed: Resume | undefined;
  opportunityId: string;
}) {
  if (followed === undefined) {
    return (
      <p className="text-sm">
        This copy is not the one this opportunity's flow follows. See{' '}
        <Link
          to="/opportunities/$id"
          params={{ id: opportunityId }}
          search={{ tab: 'resume' }}
          className="text-primary underline-offset-4 hover:underline"
        >
          the opportunity
        </Link>
        .
      </p>
    );
  }
  return (
    <p className="text-sm break-words">
      <Link
        to="/resumes/$id"
        params={{ id: followed.id }}
        className="text-primary underline-offset-4 hover:underline"
      >
        {followed.title}
      </Link>{' '}
      is the resume this opportunity's flow follows.
    </p>
  );
}
