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
import { useEffect, useId, useState } from 'react';
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
  const keywordsId = useId();
  const weakAreasId = useId();
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
              <div className="grid gap-4 text-sm">
                {/* The prose keeps a comfortable reading measure; the keywords and the weak-area
                    cards below use the card's full width instead, in columns, rather than
                    stacking into a tall single column with the right half of the card empty
                    (https://github.com/bgoleno/opportun/issues/36). */}
                <div className="grid max-w-prose gap-4">
                  <div className="grid gap-1">
                    <p className="flex items-baseline gap-2">
                      <span className="font-medium">{band(view.report.score)}</span>
                      {view.stale ? <Badge variant="outline">May be outdated</Badge> : null}
                    </p>
                    {/* The bar's value is printed beside it, not only in the page header
                      (https://github.com/bgoleno/opportun/issues/30): a bar alone cannot be
                      read exactly, and the owner asked for the number here. It follows the
                      meter in reading order, so a screen reader meets it in the same place.
                      When stale, the badge above and the dated note below mark this whole
                      block, the number included, exactly as they mark the bar. */}
                    <div className="flex items-center gap-3">
                      <meter
                        className="h-2 min-w-0 flex-1"
                        min={0}
                        max={100}
                        low={50}
                        high={70}
                        optimum={100}
                        value={view.report.score}
                        aria-label="Match score"
                      />
                      <span className="shrink-0 tabular-nums">
                        <span className="font-medium">{view.report.score}</span>{' '}
                        <span className="text-muted-foreground">/ 100</span>
                      </span>
                    </div>
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
                        Scored {formatDateTime(view.scoredAt)}. No tailoring session has completed
                        for this resume since.
                      </p>
                    )}
                  </div>
                  <p>{view.report.summary}</p>
                </div>
                {view.report.missingKeywords.length > 0 ? (
                  <div className="grid gap-2">
                    <h3 id={keywordsId} className="font-medium">
                      Missing keywords
                    </h3>
                    <ul aria-labelledby={keywordsId} className="flex flex-wrap gap-1.5">
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
                    <h3 id={weakAreasId} className="font-medium">
                      Weak areas
                    </h3>
                    {/* As many 18rem columns as fit, one below that. auto-fit, not auto-fill: a
                        report with fewer weak areas than there is room for stretches its cards
                        across the card instead of leaving empty tracks on the right (measured
                        on https://github.com/bgoleno/opportun/issues/36's PR). A column can
                        then grow wide, so each card's text is capped at max-w-prose (65ch). */}
                    <ul
                      aria-labelledby={weakAreasId}
                      className="grid grid-cols-[repeat(auto-fit,minmax(18rem,1fr))] gap-2"
                    >
                      {view.report.weakAreas.map((w) => (
                        <li key={w.area} className="rounded-md border px-3 py-2">
                          <p className="max-w-prose font-medium">{w.area}</p>
                          {/* The suggestion is the guidance, not a caption under it: it is
                              the single most actionable text on the page (issue #304), so it
                              reads at the same weight as the rest of the report, not muted. */}
                          <p className="max-w-prose">{w.suggestion}</p>
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
