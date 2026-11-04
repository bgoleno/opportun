// How the discovery pre-filter would have done on what the user accepted
// (https://github.com/bgoleno/opportun/issues/217): the figure and the count it rests on. The
// filter only measures for now; every posting is still ranked. N2b (#218) turns it on once this
// holds. Shown on the Decided tab, beside the decisions it is measured against.
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { DECIDED_PREFIX } from './api';

export interface PrefilterRecall {
  positives: number;
  kept: number;
  recall: number | null;
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

/** The line itself, in the user's words. */
export function prefilterRecallText({ positives, kept, recall }: PrefilterRecall): string {
  if (recall === null) {
    return 'Title pre-filter (measuring only, it filters nothing yet): no accepted job board postings to measure it on yet.';
  }
  const postings = positives === 1 ? 'job board posting' : 'job board postings';
  // Rounded down, so 199 of 200 does not read as 100%: N2b's bar is the exact figure.
  const percent = Math.floor((kept * 100) / positives);
  return `Title pre-filter (measuring only, it filters nothing yet): it would have kept ${kept} of the ${positives} ${postings} you accepted (${percent}%).`;
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
