// Onboarding state (FR-U11, FR-U12): one query drives the tour, the dashboard checklist and the
// auto-start trigger. Writes are awaited before the UI claims a state change (design principle 6).
import type { Checklist, Onboarding, TourState, TourStatus, TourStepId } from '@opportun/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export const onboardingKey = ['onboarding'] as const;

export const onboardingQuery = {
  queryKey: onboardingKey,
  queryFn: () => api<Onboarding>('/onboarding'),
  // A Do it now finished in another tab, or a Gmail sync that created an opportunity, shows up
  // when the user comes back to this one.
  refetchOnWindowFocus: true,
} as const;

export function useOnboarding() {
  return useQuery(onboardingQuery);
}

export function usePutTour() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { status: Exclude<TourStatus, 'not_started'>; stepId: TourStepId }) =>
      api<TourState>('/onboarding/tour', { method: 'PUT', body }),
    onSuccess: (tour) => {
      qc.setQueryData<Onboarding>(onboardingKey, (prev) =>
        prev === undefined ? prev : { ...prev, tour, autoStart: false },
      );
    },
  });
}

export function useDismissChecklist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<Checklist>('/onboarding/checklist', { method: 'PATCH', body: { dismissed: true } }),
    onSuccess: (checklist) => {
      qc.setQueryData<Onboarding>(onboardingKey, (prev) =>
        prev === undefined ? prev : { ...prev, checklist },
      );
    },
  });
}

/** The three activation items done, out of three. */
export function doneCount(c: Checklist): number {
  return [c.aiKey, c.mail, c.firstOpportunity].filter(Boolean).length;
}

/**
 * Whether the signed-in account is one of the demo's shared accounts (#546, decision 133):
 * undefined until `/onboarding` has answered. A failed read counts as not shared, so the screens
 * stay usable; what keeps the demo's own data off a form is the server's refusal, not this.
 */
export function useSharedDemoAccount(): boolean | undefined {
  const onboarding = useOnboarding();
  if (onboarding.isPending) return undefined;
  return onboarding.data?.sharedDemoAccount === true;
}
