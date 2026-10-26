// Match score for a resume against its opportunity (FR-R8, issue #175): score, gaps and
// suggestions, stored so it survives navigating away, and dated so the person can judge for
// themselves whether it still describes the document.
//
// Issue #304 split this in two. The score is a glanceable metric wanting prominence and
// almost no width, so MatchScoreHeader renders it compactly in the page header, beside the
// title and StatusControl. The summary and weak-area guidance are reading material wanting
// measure, so MatchPanelView renders them in the main column at full width, collapsible since
// the owner's loop (read guidance, edit resume, re-score, ask the agent to review) uses the
// report and the chat in alternation rather than simultaneously.
import { ChevronDown, Gauge } from 'lucide-react';
import { useEffect, useState } from 'react';
import { FormError } from '@/components/FormError';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/opportunities';
import { resumeErrorMessage, useMatchReport, useScoreMatch, type MatchReportView } from './api';
import type { Resume } from './api';

function band(score: number): string {
  if (score >= 90) return 'Excellent match';
  if (score >= 70) return 'Strong match';
  if (score >= 50) return 'Partial match';
  return 'Stretch';
}

/** The score, compactly, where the eye already lands: the page header, beside the title and
 *  StatusControl. Renders nothing until there is a number to show. */
export function MatchScoreHeader({ view }: { view: MatchReportView | null | undefined }) {
  if (view === null || view === undefined) return null;
  return (
    <div className="flex items-baseline gap-2 rounded-md border px-3 py-1.5">
      <span className="text-2xl font-semibold tabular-nums">{view.report.score}</span>
      <span className="text-sm text-muted-foreground">/ 100, {band(view.report.score)}</span>
      {view.stale ? <Badge variant="outline">May be outdated</Badge> : null}
    </div>
  );
}

export interface MatchPanelViewProps {
  opportunityId: string | null;
  /** undefined while the stored report is still loading; null once confirmed never scored. */
  view: MatchReportView | null | undefined;
  scoring: boolean;
  error: unknown;
  onScore: () => void;
}

/** The three states a person can actually be shown: never scored, scored, scored but stale. */
export function MatchPanelView({
  opportunityId,
  view,
  scoring,
  error,
  onScore,
}: MatchPanelViewProps) {
  // Open whenever a report changes identity (a fresh score, or staleness newly flipping true):
  // that is the moment there is something new worth noticing. Never auto-closed: "collapsed
  // once the conversation is underway" is the reader's own action once they have read it, not
  // a timer guessing when they are done with it.
  const [open, setOpen] = useState(true);
  useEffect(() => {
    setOpen(true);
    // Only the report's own identity should force this open; a parent re-render with the same
    // report (e.g. scoring/error changing) must not fight a reader who just collapsed it.
  }, [view?.scoredAt, view?.stale]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Match report</CardTitle>
        <CardDescription>How well the current document fits the job description.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {opportunityId === null ? (
          <p className="text-sm text-muted-foreground">
            Base resumes are not linked to a job. Create a tailored copy from an opportunity to
            score it.
          </p>
        ) : (
          <Button
            variant="outline"
            className="w-fit"
            disabled={scoring || view === undefined}
            onClick={onScore}
          >
            <Gauge aria-hidden="true" />
            {scoring
              ? 'Scoring...'
              : view === undefined
                ? 'Loading...'
                : view === null
                  ? 'Score match'
                  : 'Score again'}
          </Button>
        )}
        {error ? <FormError message={resumeErrorMessage(error) ?? errorMessage(error)} /> : null}
        {view ? (
          <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="w-fit justify-start gap-1.5 -ml-2">
                <ChevronDown
                  aria-hidden="true"
                  className={
                    open ? 'size-4 transition-transform' : 'size-4 -rotate-90 transition-transform'
                  }
                />
                {open ? 'Hide details' : 'Show details'}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              {/* A comfortable reading measure now that this lives at full column width,
                  not the 45-75 character default a maximally wide line would blow past. */}
              <div className="grid max-w-[65ch] gap-4 text-sm">
                <div className="grid gap-1">
                  {/* The number itself lives in the page header now (MatchScoreHeader),
                      where it is always visible; repeating it here, only reachable once this
                      section is expanded, would just be the same digits twice on one page. */}
                  <p className="flex items-baseline gap-2">
                    <span className="font-medium">{band(view.report.score)}</span>
                    {view.stale ? <Badge variant="outline">May be outdated</Badge> : null}
                  </p>
                  <meter
                    className="h-2 w-full"
                    min={0}
                    max={100}
                    low={50}
                    high={70}
                    optimum={100}
                    value={view.report.score}
                    aria-label="Match score"
                  />
                  {view.stale ? (
                    // A tailoring session changed the document after this was scored: say so,
                    // rather than showing the old score as if it still describes what is
                    // there now (design principle 6: report only outcomes actually observed).
                    <p className="text-xs text-muted-foreground">
                      Scored {formatDateTime(view.scoredAt)}. A tailoring session has completed
                      since, so this may no longer reflect the current document.
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Scored {formatDateTime(view.scoredAt)}. No tailoring session has completed for
                      this resume since.
                    </p>
                  )}
                </div>
                <p>{view.report.summary}</p>
                {view.report.missingKeywords.length > 0 ? (
                  <div className="grid gap-2">
                    <h3 className="font-medium">Missing keywords</h3>
                    <ul className="flex flex-wrap gap-1.5">
                      {view.report.missingKeywords.map((k) => (
                        <li key={k}>
                          <Badge variant="outline">{k}</Badge>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {view.report.weakAreas.length > 0 ? (
                  <div className="grid gap-2">
                    <h3 className="font-medium">Weak areas</h3>
                    <ul className="grid gap-2">
                      {view.report.weakAreas.map((w) => (
                        <li key={w.area} className="rounded-md border px-3 py-2">
                          <p className="font-medium">{w.area}</p>
                          {/* The suggestion is the guidance, not a caption under it: it is
                              the single most actionable text on the page (issue #304), so it
                              reads at the same weight as the rest of the report, not muted. */}
                          <p>{w.suggestion}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function MatchPanel({ resume }: { resume: Resume }) {
  const opportunityId = resume.opportunityId;
  const query = useMatchReport(resume.id, opportunityId);
  const score = useScoreMatch(resume.id);

  return (
    <MatchPanelView
      opportunityId={opportunityId}
      view={query.isPending ? undefined : (query.data ?? null)}
      scoring={score.isPending}
      error={score.error}
      onScore={() => {
        if (opportunityId !== null) score.mutate(opportunityId);
      }}
    />
  );
}
