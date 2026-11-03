// How the discovery pre-filter would have done on what the user accepted
// (https://github.com/bgoleno/opportun/issues/217): the figure and the count it rests on. The
// filter only measures for now; every posting is still ranked. N2b (#218) turns it on once this
// holds. Shown on the Decided tab, beside the decisions it is measured against.
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface PrefilterRecall {
  positives: number;
  kept: number;
  recall: number | null;
}

export const prefilterRecallKey = ['discovery', 'prefilter', 'recall'] as const;

export function usePrefilterRecall() {
  return useQuery({
    queryKey: prefilterRecallKey,
    queryFn: () => api<PrefilterRecall>('/discovery/prefilter/recall'),
  });
}

/** The line itself, in the user's words. */
export function prefilterRecallText({ positives, kept, recall }: PrefilterRecall): string {
  if (recall === null) {
    return 'Title pre-filter (measuring only, it filters nothing yet): no accepted postings to measure it on yet.';
  }
  const postings = positives === 1 ? 'posting' : 'postings';
  return `Title pre-filter (measuring only, it filters nothing yet): it would have kept ${kept} of the ${positives} ${postings} you accepted (${Math.round(recall * 100)}%).`;
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
