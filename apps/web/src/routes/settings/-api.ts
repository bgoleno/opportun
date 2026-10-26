// Settings data: queries and optimistic mutations for profile, role targets and resume
// rules (AI provider keys live in components/ai/api.ts). Mutations update the cache first,
// roll back on error (with a toast), and refetch afterwards so the cache matches the server.
import type { Profile, ResumeRule, RoleTarget } from '@opportun/core';
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import type { RoleTargetPayload } from './-roleTargetForm';

export interface Page<T> {
  items: T[];
  total: number;
}

export type ProfileInput = Pick<
  Profile,
  'fullName' | 'headline' | 'email' | 'phone' | 'location' | 'workAuth'
> & { links: { label: string; url: string }[] };

export interface ResumeRuleInput {
  ruleText: string;
  category: ResumeRule['category'];
  active: boolean;
  sortOrder: number;
}

export const keys = {
  profile: ['profile'] as const,
  roleTargets: ['role-targets'] as const,
  resumeRules: ['resume-rules'] as const,
};

let tempSeq = 0;
/** Placeholder id for an optimistically inserted row until the server answers. */
export function tempId(): string {
  tempSeq += 1;
  return `optimistic-${tempSeq}`;
}
export const isTemp = (id: string): boolean => id.startsWith('optimistic-');

/**
 * A mutation whose effect on a cached value is applied immediately. `apply` receives the
 * current cached value (if any) and returns the predicted one.
 */
function useOptimistic<TData, TVars, TResult>(opts: {
  queryKey: QueryKey;
  mutationFn: (vars: TVars) => Promise<TResult>;
  apply: (current: TData, vars: TVars) => TData;
  errorTitle: string;
}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: opts.mutationFn,
    onMutate: async (vars: TVars) => {
      await qc.cancelQueries({ queryKey: opts.queryKey });
      const previous = qc.getQueryData<TData>(opts.queryKey);
      if (previous !== undefined) qc.setQueryData<TData>(opts.queryKey, opts.apply(previous, vars));
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous !== undefined) qc.setQueryData(opts.queryKey, context.previous);
      toast({ title: opts.errorTitle, description: errorMessage(err), variant: 'destructive' });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: opts.queryKey }),
  });
}

const now = () => Date.now();

// --- profile ---------------------------------------------------------------

export function useProfile() {
  return useQuery({ queryKey: keys.profile, queryFn: () => api<Profile>('/profile') });
}

export function useSaveProfile() {
  return useOptimistic<Profile, ProfileInput, Profile>({
    queryKey: keys.profile,
    mutationFn: (input) => api<Profile>('/profile', { method: 'PUT', body: input }),
    apply: (current, input) => ({ ...current, ...input, updatedAt: now() }),
    errorTitle: 'Profile not saved',
  });
}

// --- role targets ----------------------------------------------------------

export function useRoleTargets() {
  return useQuery({
    queryKey: keys.roleTargets,
    queryFn: () => api<Page<RoleTarget>>('/role-targets?limit=200&sort=name'),
  });
}

export function useCreateRoleTarget() {
  return useOptimistic<Page<RoleTarget>, RoleTargetPayload, RoleTarget>({
    queryKey: keys.roleTargets,
    mutationFn: (body) => api<RoleTarget>('/role-targets', { method: 'POST', body }),
    apply: (page, body) => ({
      items: [
        ...page.items,
        {
          ...body,
          id: tempId(),
          userId: '',
          discoveryPromptId: null,
          createdAt: now(),
          updatedAt: now(),
        },
      ],
      total: page.total + 1,
    }),
    errorTitle: 'Role target not created',
  });
}

export function useUpdateRoleTarget() {
  return useOptimistic<
    Page<RoleTarget>,
    { id: string; patch: Partial<RoleTargetPayload> },
    RoleTarget
  >({
    queryKey: keys.roleTargets,
    mutationFn: ({ id, patch }) =>
      api<RoleTarget>(`/role-targets/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
    apply: (page, { id, patch }) => ({
      ...page,
      items: page.items.map((t) => (t.id === id ? { ...t, ...patch, updatedAt: now() } : t)),
    }),
    errorTitle: 'Role target not updated',
  });
}

export function useDeleteRoleTarget() {
  return useOptimistic<Page<RoleTarget>, string, void>({
    queryKey: keys.roleTargets,
    mutationFn: (id) => api<void>(`/role-targets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    apply: (page, id) => ({
      items: page.items.filter((t) => t.id !== id),
      total: Math.max(0, page.total - 1),
    }),
    errorTitle: 'Role target not deleted',
  });
}

// --- resume rules ----------------------------------------------------------

const byOrder = (a: ResumeRule, b: ResumeRule) => a.sortOrder - b.sortOrder;

export function useResumeRules() {
  return useQuery({
    queryKey: keys.resumeRules,
    queryFn: () => api<Page<ResumeRule>>('/resume-rules?limit=200&sort=sortOrder'),
  });
}

export function useCreateResumeRule() {
  return useOptimistic<Page<ResumeRule>, ResumeRuleInput, ResumeRule>({
    queryKey: keys.resumeRules,
    mutationFn: (body) => api<ResumeRule>('/resume-rules', { method: 'POST', body }),
    apply: (page, body) => ({
      items: [
        ...page.items,
        { ...body, id: tempId(), userId: '', createdAt: now(), updatedAt: now() },
      ].sort(byOrder),
      total: page.total + 1,
    }),
    errorTitle: 'Rule not created',
  });
}

export function useUpdateResumeRule() {
  return useOptimistic<
    Page<ResumeRule>,
    { id: string; patch: Partial<ResumeRuleInput> },
    ResumeRule
  >({
    queryKey: keys.resumeRules,
    mutationFn: ({ id, patch }) =>
      api<ResumeRule>(`/resume-rules/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
    apply: (page, { id, patch }) => ({
      ...page,
      items: page.items
        .map((r) => (r.id === id ? { ...r, ...patch, updatedAt: now() } : r))
        .sort(byOrder),
    }),
    errorTitle: 'Rule not updated',
  });
}

export function useDeleteResumeRule() {
  return useOptimistic<Page<ResumeRule>, string, void>({
    queryKey: keys.resumeRules,
    mutationFn: (id) => api<void>(`/resume-rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    apply: (page, id) => ({
      items: page.items.filter((r) => r.id !== id),
      total: Math.max(0, page.total - 1),
    }),
    errorTitle: 'Rule not deleted',
  });
}
