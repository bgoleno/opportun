import { OPPORTUNITY_STAGES, type OpportunityStage } from '@opportun/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { z } from 'zod';
import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { qk, type DashboardData, type OpportunityView, type Page } from '@/lib/opportunities';

/** The API's page cap; the pipeline needs every opportunity, so it walks the pages. */
const PAGE = 200;

export async function fetchAllOpportunities(): Promise<Page<OpportunityView>> {
  const items: OpportunityView[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await api<Page<OpportunityView>>(
      `/opportunities?sort=-updatedAt&limit=${PAGE}&offset=${offset}`,
    );
    items.push(...page.items);
    if (page.items.length < PAGE || items.length >= page.total) {
      return { items, total: page.total };
    }
  }
}

export function useAllOpportunities() {
  return useQuery({
    queryKey: qk.opportunityList({ scope: 'all' }),
    queryFn: fetchAllOpportunities,
  });
}

/**
 * Saves a drag reorder within a column (issue #240), in one request rather than one PATCH per
 * card whose `sortOrder` actually moved (see reorderColumn). A full renumber -- what every
 * untouched column's shared sortOrder default of 0 guarantees the *first* drag in it will be --
 * can touch most of a large column at once; N independent PATCHes have no atomicity (a failure
 * partway leaves the stored order inconsistent with what's on screen) and, on a column the size
 * of a real Discovered list, queue behind the browser's per-origin connection cap rather than
 * firing as one burst. POST /opportunities/reorder applies the whole batch in one transaction
 * instead (see reorderOpportunities server-side).
 *
 * Applied optimistically to every cached opportunity list -- the partial key matches the
 * board's own `useAllOpportunities` cache, same as useStageFlow's stage updates do -- so the
 * drop holds instead of snapping back while the request is in flight. Unlike before this fix,
 * a failure now rolls back to the exact pre-drag snapshot rather than just toasting and hoping
 * the next refetch sorts it out: with one atomic request, a failure means nothing was saved, so
 * the optimistic update is the only thing that could be wrong, and undoing it is well-defined.
 */
export function useReorderOpportunities() {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (changes: { id: string; sortOrder: number }[]) =>
      api<null>('/opportunities/reorder', { method: 'POST', body: { changes } }),
    onMutate: async (changes) => {
      await qc.cancelQueries({ queryKey: qk.opportunities });
      const previous = qc.getQueriesData<Page<OpportunityView>>({ queryKey: qk.opportunities });
      const by = new Map(changes.map((c) => [c.id, c.sortOrder]));
      qc.setQueriesData<Page<OpportunityView>>({ queryKey: qk.opportunities }, (old) =>
        old === undefined
          ? old
          : {
              ...old,
              items: old.items.map((o) => (by.has(o.id) ? { ...o, sortOrder: by.get(o.id)! } : o)),
            },
      );
      return { previous };
    },
    onError: (_err, _changes, context) => {
      for (const [key, data] of context?.previous ?? []) qc.setQueryData(key, data);
      toast({
        title: 'Order not saved',
        description: 'The board has been restored.',
        variant: 'destructive',
      });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.opportunities }),
  });
  return mutation.mutate;
}

/**
 * Earliest open next step per opportunity, from the dashboard's due list (open steps due
 * within the next 7 days or overdue, on active opportunities). The list API carries no
 * next-step data, so later steps show no date.
 */
export function useNextDue(): ReadonlyMap<string, number> {
  const { data } = useQuery({
    queryKey: qk.dashboard,
    queryFn: () => api<DashboardData>('/dashboard'),
  });
  return useMemo(() => {
    const due = new Map<string, number>();
    for (const step of data?.dueNextSteps ?? []) {
      if (step.dueAt == null) continue;
      const prev = due.get(step.opportunityId);
      if (prev === undefined || step.dueAt < prev) due.set(step.opportunityId, step.dueAt);
    }
    return due;
  }, [data]);
}

export const SORT_KEYS = [
  'company',
  'title',
  'stage',
  'source',
  'updated',
  'priority',
  'due',
  /** The board's manual order (issue #240): a sort option here, not a second drag surface. */
  'order',
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

/** URL search params for /pipeline: the saved view and filter. */
export const PipelineSearchSchema = z.object({
  view: z.enum(['board', 'table']).optional().catch(undefined),
  stage: z.enum(OPPORTUNITY_STAGES).optional().catch(undefined),
  q: z.string().max(200).optional().catch(undefined),
  sort: z.enum(SORT_KEYS).optional().catch(undefined),
  dir: z.enum(['asc', 'desc']).optional().catch(undefined),
  /** Opens the New opportunity dialog (the setup checklist and the tour link here). */
  new: z.boolean().optional().catch(undefined),
});
export type PipelineSearch = z.infer<typeof PipelineSearchSchema>;

export function matchesFilter(
  opp: OpportunityView,
  stage: OpportunityStage,
  filter: { stage?: OpportunityStage | undefined; q?: string | undefined },
): boolean {
  if (filter.stage !== undefined && stage !== filter.stage) return false;
  const q = filter.q?.trim().toLowerCase();
  if (!q) return true;
  return [opp.companyName, opp.title, opp.location ?? ''].some((f) => f.toLowerCase().includes(q));
}
