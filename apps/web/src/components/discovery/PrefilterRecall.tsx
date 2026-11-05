// How the discovery pre-filter does on what the user accepted
// (https://github.com/bgoleno/opportun/issues/217): the figure and the count it rests on. Once that
// holds it acts on new board postings (#218): the Decided tab shows the line, beside the decisions
// it is measured against, and Settings > AI the card, with why it is on or not and what it saves.
import { useQuery } from '@tanstack/react-query';
import { FormError } from '@/components/FormError';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, errorMessage } from '@/lib/api';
import { DECIDED_PREFIX } from './api';

export interface PrefilterRecall {
  positives: number;
  kept: number;
  recall: number | null;
  /** Whether recall holds, so that job boards act on the verdicts. */
  on: boolean;
  neededRecall: number;
  neededPositives: number;
  /** Postings judged when they arrived, and those it filtered. */
  judged: number;
  filtered: number;
}

// Under the decided prefix, so that deciding a result refreshes it.
export const prefilterRecallKey = [...DECIDED_PREFIX, 'prefilter-recall'] as const;

export function usePrefilterRecall() {
  return useQuery({
    queryKey: prefilterRecallKey,
    queryFn: () => api<PrefilterRecall>('/discovery/prefilter/recall'),
    // The server works it out on each read, against the current role targets, and an edit to one
    // of those on the Settings page does not invalidate this. Asked afresh on every visit.
    staleTime: 0,
  });
}

/** Rounded down, so 199 of 200 does not read as 100%: the bar is the exact figure. */
const percentKept = (kept: number, positives: number): number =>
  Math.floor((kept * 100) / positives);

/** The line itself, in the user's words. */
export function prefilterRecallText({
  positives,
  kept,
  recall,
  on,
}: Pick<PrefilterRecall, 'positives' | 'kept' | 'recall'> & { on?: boolean }): string {
  const prefix =
    on === true
      ? 'Title pre-filter (on for your job boards)'
      : 'Title pre-filter (measuring only, it filters nothing yet)';
  if (recall === null) {
    return `${prefix}: no accepted job board postings to measure it on yet.`;
  }
  const postings = positives === 1 ? 'job board posting' : 'job board postings';
  return `${prefix}: it would have kept ${kept} of the ${positives} ${postings} you accepted (${percentKept(kept, positives)}%).`;
}

/** Whether it is on, and if not, why not (#218 criterion 2). */
export function prefilterStatusText(s: PrefilterRecall): string {
  const needed = Math.round(s.neededRecall * 100);
  if (s.on) {
    return `On for your job boards: judged against your role targets as they are now, it would have kept ${s.kept} of the ${s.positives} job board postings you accepted (${percentKept(s.kept, s.positives)}%).`;
  }
  if (s.positives < s.neededPositives) {
    return `Measuring only, it filters nothing yet: you have accepted ${s.positives} of the ${s.neededPositives} job board postings it needs, and it must keep at least ${needed}% of them.`;
  }
  return `Measuring only, it filters nothing yet: judged against your role targets as they are now, it would have kept ${s.kept} of the ${s.positives} job board postings you accepted (${percentKept(s.kept, s.positives)}%), and it needs at least ${needed}%.`;
}

/** What it saves (#218 criterion 6). Recall alone cannot show that: passing everything scores 100%. */
export function prefilterShareText({ judged, filtered }: PrefilterRecall): string {
  if (judged === 0) return 'It has not judged a posting yet.';
  const postings = judged === 1 ? 'posting' : 'postings';
  return `Of the ${judged} ${postings} judged when they arrived, it filtered ${filtered} (${Math.round((filtered * 100) / judged)}%).`;
}

export function PrefilterCard() {
  const { data, error } = usePrefilterRecall();
  return (
    // min-w-0: a grid item is as wide as its content by default (as RankCostCard).
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>Discovery pre-filter</CardTitle>
        <CardDescription>
          Skips the AI for job board postings whose title, place or remote setting clearly do not
          fit your role targets. Job alert emails are never filtered.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {error ? <FormError message={errorMessage(error)} /> : null}
        {data === undefined ? null : (
          <>
            <p className="max-w-prose text-sm" data-testid="prefilter-status">
              {prefilterStatusText(data)}
            </p>
            <p className="max-w-prose text-sm text-muted-foreground" data-testid="prefilter-share">
              {prefilterShareText(data)}
            </p>
            {data.on ? (
              <p
                className="max-w-prose text-sm text-muted-foreground"
                data-testid="prefilter-caveat"
              >
                The kept figure can read high now that it is on, because you rarely accept a posting
                with no score.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function PrefilterRecallLine() {
  const { data } = usePrefilterRecall();
  if (data === undefined) return null;
  return (
    <p className="max-w-prose text-sm text-muted-foreground" data-testid="prefilter-recall">
      {prefilterRecallText(data)}
    </p>
  );
}
