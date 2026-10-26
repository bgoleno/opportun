// Mail filter settings data (spec D7). Plain queries and invalidating mutations rather than
// the optimistic helper used for role targets: these rules decide what Opportun is allowed to
// look at, so showing a rule as saved before the server agrees would misstate the one thing
// this page exists to be precise about.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';

export type MailFilterEffect = 'allow' | 'deny' | 'job_sender';

export interface MailFilterRule {
  id: string;
  pattern: string;
  effect: MailFilterEffect;
  enabled: boolean;
  source: string;
  note: string | null;
  createdAt: number;
}

export interface MailFilters {
  rules: MailFilterRule[];
  label: string | null;
  consumerVeto: boolean;
}

/**
 * One row of rule 4's pass list: a built-in that ships with the release, or one the user added.
 * `matchCount` is counted against the senders already in their mail, so a pattern that matches
 * nothing is obvious rather than silently inert.
 */
export interface JobSender {
  pattern: string;
  /** The platform a built-in belongs to; empty for one the user added. */
  platform: string;
  /** What it sends, so a built-in can be judged rather than trusted. */
  sends: string;
  builtIn: boolean;
  enabled: boolean;
  matchCount: number;
  /** The rule behind the row: the user's own, or the disabled rule muting a built-in. */
  ruleId: string | null;
}

export interface PatternTest {
  valid: boolean;
  matchCount: number;
  sampleDomains: string[];
  suggestions: { pattern: string; matchCount: number }[];
}

export const mailFilterKeys = { all: ['mail-filters'] as const };

export function useMailFilters() {
  return useQuery({
    queryKey: mailFilterKeys.all,
    queryFn: () => api<MailFilters>('/mail-filters'),
  });
}

/** Any mutation here invalidates the whole page: the lists and the scope read together. */
function useFilterMutation<TVars, TResult>(mutationFn: (vars: TVars) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onError: (err) => toast({ title: errorMessage(err), variant: 'destructive' }),
    onSettled: () => {
      // mailFilterKeys.all is a prefix of jobSenderKeys.all, so one invalidation covers the
      // lists, the scope and the merged job-sender view.
      void qc.invalidateQueries({ queryKey: mailFilterKeys.all });
    },
  });
}

export function useCreateRule() {
  return useFilterMutation((body: { pattern: string; effect: MailFilterEffect }) =>
    api<MailFilterRule>('/mail-filters', { method: 'POST', body }),
  );
}

export function useUpdateRule() {
  return useFilterMutation((vars: { id: string; enabled?: boolean; note?: string | null }) =>
    api<MailFilterRule>(`/mail-filters/${vars.id}`, {
      method: 'PATCH',
      body: { enabled: vars.enabled, note: vars.note },
    }),
  );
}

export function useDeleteRule() {
  return useFilterMutation((id: string) => api<void>(`/mail-filters/${id}`, { method: 'DELETE' }));
}

export function useSetLabel() {
  return useFilterMutation((label: string | null) =>
    api<{ label: string | null }>('/mail-filters/label', { method: 'PUT', body: { label } }),
  );
}

export function useSetConsumerVeto() {
  return useFilterMutation((enabled: boolean) =>
    api<{ enabled: boolean }>('/mail-filters/consumer-veto', {
      method: 'PUT',
      body: { enabled },
    }),
  );
}

export const jobSenderKeys = { all: ['mail-filters', 'job-senders'] as const };

/**
 * Its own query rather than part of `/mail-filters`: the match counts need a scan of the user's
 * senders, and the lists above should not wait for it.
 */
export function useJobSenders() {
  return useQuery({
    queryKey: jobSenderKeys.all,
    queryFn: () => api<{ senders: JobSender[] }>('/mail-filters/job-senders'),
  });
}

/**
 * Switching a built-in off and on (decision D-3). The server stores off as a DISABLED rule
 * naming the same pattern and on as the absence of one, so the client says what the user meant
 * and not how it is recorded.
 */
export function useSetBuiltInJobSender() {
  return useFilterMutation((vars: { pattern: string; enabled: boolean }) =>
    api<{ enabled: boolean }>('/mail-filters/job-senders', { method: 'PUT', body: vars }),
  );
}

export function useTestPattern() {
  return useMutation({
    mutationFn: (pattern: string) =>
      api<PatternTest>('/mail-filters/test', { method: 'POST', body: { pattern } }),
  });
}
