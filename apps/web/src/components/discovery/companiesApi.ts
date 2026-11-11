// Company discovery data (FR-D8, FR-D9): the suggestion queue (accept follows the company,
// deny is permanent) and the followed companies with their ATS board detection state. Shapes
// mirror apps/server/src/routes/companies.ts and companySuggestions.ts.
//
// Company names and suggestion rationales come from the model or third parties: components
// render them as plain text, never as markdown or HTML.
import type { CompanyStatus, IndustryTagSource, NaicsTier } from '@opportun/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@/components/ui/toast';
import { api, ApiError, errorMessage } from '@/lib/api';
import type { Page } from '@/lib/opportunities';
import { ATS_KINDS, discoveryKeys, sourceKindLabel, type AtsKind } from './api';

export interface CompanyView {
  id: string;
  userId: string;
  name: string;
  domain?: string | null;
  careersUrl?: string | null;
  status: CompanyStatus;
  suggestionRationale?: string | null;
  /** An ATS source kind once detected, 'none' when nothing was found, null before detection. */
  atsKind?: string | null;
  atsRef?: string | null;
  atsVerifiedAt?: number | null;
  notes?: string | null;
  /** A NAICS 2022 industry group (#220); null when untagged, or the model could not place it. */
  naicsCode?: string | null;
  industrySource?: IndustryTagSource | null;
  /** Set once it was tagged or tried. */
  industryAt?: number | null;
  atsDetectPending: boolean;
  needsCareersUrl: boolean;
  /**
   * The board probe's result (#221, #301): when it ran, how many postings the board had open and how
   * many of them the pre-filter passes; null until it has run. True while a probe job is waiting.
   */
  boardProbedAt?: number | null;
  boardOpenJobs?: number | null;
  boardPrefilterMatches?: number | null;
  boardProbePending?: boolean;
  createdAt: number;
  updatedAt: number;
}

export const companyKeys = {
  suggestions: ['companies', 'suggestions'] as const,
  followed: ['companies', { status: 'followed' }] as const,
  denied: ['companies', { status: 'denied' }] as const,
  network: (showDenied: boolean) => ['companies', 'network', { showDenied }] as const,
};

const enc = encodeURIComponent;

/** A short label for the detected board: "Greenhouse", "No board found", "Not checked yet". */
export function atsLabel(kind: string | null | undefined): string {
  if (kind == null) return 'Not checked yet';
  if (kind === 'none') return 'No board found';
  return (ATS_KINDS as readonly string[]).includes(kind) ? sourceKindLabel(kind as AtsKind) : kind;
}

/** The public page of each slug-addressed board kind, as the board's own site shows it. */
const BOARD_PAGES: ReadonlyMap<string, string> = new Map([
  ['ats_greenhouse', 'boards.greenhouse.io'],
  ['ats_lever', 'jobs.lever.co'],
  ['ats_ashby', 'jobs.ashbyhq.com'],
]);

/**
 * The address of a Greenhouse, Lever or Ashby board's public page, or null for any other kind or
 * no board. Shown on a candidate's row (#296): a board found by guessing names from the company's
 * name can belong to another company of the same name, and the address lets the user see whose it
 * is before following.
 */
export function boardAddress(
  kind: string | null | undefined,
  ref: string | null | undefined,
): { href: string; text: string } | null {
  const host = kind == null ? undefined : BOARD_PAGES.get(kind);
  if (host === undefined || ref == null || ref === '') return null;
  return { href: `https://${host}/${enc(ref)}`, text: `${host}/${ref}` };
}

/** While a probe is running the list is read again, so the result shows when it lands. */
const PROBE_POLL_MS = 3000;
const probing = (rows: readonly CompanyView[] | undefined): boolean =>
  rows?.some((c) => c.boardProbePending === true) === true;

export function useCompanySuggestions() {
  return useQuery({
    queryKey: companyKeys.suggestions,
    queryFn: () => api<Page<CompanyView>>('/companies/suggestions?limit=200&sort=-createdAt'),
    refetchInterval: (q) => (probing(q.state.data?.items) ? PROBE_POLL_MS : false),
  });
}

export function useFollowedCompanies() {
  return useQuery({
    queryKey: companyKeys.followed,
    queryFn: () => api<Page<CompanyView>>('/companies?status=followed&limit=200&sort=name'),
  });
}

/** Companies denied by name, not just denied suggestions (issue #199): the deny list the user
 *  built directly, for them to review and undo. */
export function useDeniedCompanies() {
  return useQuery({
    queryKey: companyKeys.denied,
    queryFn: () => api<Page<CompanyView>>('/companies?status=denied&limit=200&sort=name'),
  });
}

/**
 * Denies a company by name directly (issue #199): today's only other path to 'denied' is
 * accepting or denying a suggestion the system already proposed, which does nothing for a
 * company -- a previous employer, one the user simply dislikes -- that was never suggested.
 * Reuses POST /companies (already accepts a status), so no backend change was needed for this
 * specific gap; the gap was entirely that the web UI never offered it.
 *
 * Deliberately returns the pending-results count alongside the created company, read right
 * after denying rather than offering to act on it: #199's own requirement to let the user
 * clear already-queued postings from this company was cut for tonight (filed separately) since
 * #184's bulk triage already lets them select and dismiss those themselves. This is the
 * "say so" half of that cut, not a silent gap.
 */
export function useDenyCompanyByName() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const company = await api<CompanyView>('/companies', {
        method: 'POST',
        body: { name, status: 'denied' },
      });
      const { count } = await api<{ count: number }>(`/companies/${enc(company.id)}/pending-count`);
      return { company, pendingCount: count };
    },
    onSuccess: ({ company, pendingCount }) =>
      toast({
        title: 'Denied',
        description:
          pendingCount > 0
            ? `${company.name}. ${pendingCount} pending result${pendingCount === 1 ? '' : 's'} from ${company.name} ${pendingCount === 1 ? 'is' : 'are'} still in your review queue -- they stay until you dismiss them yourself.`
            : company.name,
      }),
    onError: (err) =>
      toast({
        title: 'Not denied',
        description:
          err instanceof ApiError && err.code === 'duplicate'
            ? 'A company with that name already exists; deny it from the list instead.'
            : errorMessage(err),
        variant: 'destructive',
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['companies'] }),
  });
}

/** Un-denies a company (issue #199): the undo for a direct deny. Stops future postings from
 *  being suppressed; does not retroactively restore anything already suppressed under the old
 *  status (restoring an auto-suppressed result to the queue is its own, separately filed gap). */
export function useUndenyCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (c: CompanyView) =>
      api<CompanyView>(`/companies/${enc(c.id)}`, { method: 'PATCH', body: { status: 'none' } }),
    onSuccess: (_res, c) => toast({ title: 'No longer denied', description: c.name }),
    onError: (err) =>
      toast({ title: 'Not undone', description: errorMessage(err), variant: 'destructive' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['companies'] }),
  });
}

/** Accept or deny: the suggestion leaves the queue at once and comes back if refused. */
function useDecision(action: 'accept' | 'deny') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (c: CompanyView) =>
      api<CompanyView>(`/companies/${enc(c.id)}/${action}`, { method: 'POST' }),
    onMutate: async (c: CompanyView) => {
      await qc.cancelQueries({ queryKey: companyKeys.suggestions });
      const previous = qc.getQueryData<Page<CompanyView>>(companyKeys.suggestions);
      if (previous !== undefined) {
        qc.setQueryData<Page<CompanyView>>(companyKeys.suggestions, {
          items: previous.items.filter((s) => s.id !== c.id),
          total: Math.max(0, previous.total - 1),
        });
      }
      return { previous };
    },
    onSuccess: (_res, c) =>
      toast({
        title: action === 'accept' ? 'Following' : 'Suggestion denied',
        description: c.name,
        variant: action === 'accept' ? 'success' : 'default',
      }),
    onError: (err, _c, context) => {
      if (context?.previous !== undefined) {
        qc.setQueryData(companyKeys.suggestions, context.previous);
      }
      toast({
        title: action === 'accept' ? 'Not followed' : 'Not denied',
        description:
          err instanceof ApiError && err.code === 'not_suggested'
            ? 'That company is no longer a pending suggestion.'
            : errorMessage(err),
        variant: 'destructive',
      });
    },
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['companies'] }),
        qc.invalidateQueries({ queryKey: discoveryKeys.sources }),
      ]),
  });
}

export const useAcceptCompany = () => useDecision('accept');
export const useDenyCompany = () => useDecision('deny');

/** Queues ATS board detection (the server dedupes while one is unfinished). */
export function useDetectAts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ jobId: string }>(`/companies/${enc(id)}/detect-ats`, { method: 'POST' }),
    onSuccess: () => toast({ title: 'Board detection queued' }),
    onError: (err) =>
      toast({
        title: 'Detection not queued',
        description: errorMessage(err),
        variant: 'destructive',
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: companyKeys.followed }),
  });
}

/**
 * Saves the careers URL, then queues detection so the new URL is scanned. Only a failed save
 * rejects (the row's form shows it). A failed detection does not: the URL is saved, the refetch
 * unmounts the careers form, so the failure is reported by toast here instead.
 */
export function useSetCareersUrl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, careersUrl }: { id: string; careersUrl: string }) => {
      const company = await api<CompanyView>(`/companies/${enc(id)}`, {
        method: 'PATCH',
        body: { careersUrl },
      });
      try {
        await api<{ jobId: string }>(`/companies/${enc(id)}/detect-ats`, { method: 'POST' });
      } catch (err) {
        toast({
          title: 'Careers URL saved, detection not queued',
          description: `${errorMessage(err)} Use Detect now to retry.`,
          variant: 'destructive',
        });
        return { company, detected: false };
      }
      toast({ title: 'Careers URL saved', description: company.name, variant: 'success' });
      return { company, detected: true };
    },
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: companyKeys.followed }),
        qc.invalidateQueries({ queryKey: discoveryKeys.sources }),
      ]),
  });
}

/** found: a board is recorded; not_found: detection found none; not_checked: never run. */
export type BoardState = 'found' | 'not_found' | 'not_checked';

/** One company the user has a current contact at (https://github.com/bgoleno/opportun/issues/216),
 *  as GET /discovery/network-companies returns it (apps/server/src/routes/networkCompanies.ts). */
export interface NetworkCompany {
  company: CompanyView;
  board: BoardState;
  contactCount: number;
  /** 1 acquaintance, 2 know well, 3 close; null when no contact here has a strength set. */
  strongestStrength: number | null;
  /** Strongest first. */
  contacts: { id: string; name: string; strength: number | null }[];
}

/** The companies in the user's network, read from their own contacts: no AI call. */
export function useNetworkCompanies(showDenied: boolean) {
  return useQuery({
    queryKey: companyKeys.network(showDenied),
    queryFn: () =>
      api<{ items: NetworkCompany[] }>(
        `/discovery/network-companies${showDenied ? '?showDenied=true' : ''}`,
      ),
    refetchInterval: (q) =>
      probing(q.state.data?.items.map((i) => i.company)) ? PROBE_POLL_MS : false,
  });
}

/** Why Check board was refused, in the user's words (#301). */
function checkBoardFailure(err: unknown): string {
  if (err instanceof ApiError && err.status === 429 && err.code === 'rate_limited') {
    const { max, windowMinutes, retryAfterSec } = err.details;
    const most = typeof max === 'number' && Number.isInteger(max) && max > 0 ? max : 30;
    const per =
      windowMinutes === 60 || typeof windowMinutes !== 'number'
        ? 'an hour'
        : `every ${windowMinutes} minutes`;
    const m =
      typeof retryAfterSec === 'number' && retryAfterSec > 0 && retryAfterSec <= 86_400
        ? Math.ceil(retryAfterSec / 60)
        : null;
    const wait = m === null ? 'a few minutes' : `about ${m} minute${m === 1 ? '' : 's'}`;
    return `You can check up to ${most} boards ${per}. Try again in ${wait}.`;
  }
  if (err instanceof ApiError && err.code === 'already_checked') {
    return 'That company was already checked.';
  }
  if (err instanceof ApiError && err.code === 'not_a_candidate') {
    return 'Only a company you have not followed or denied can be checked.';
  }
  return errorMessage(err);
}

/**
 * Check board (#301): the user's click asks for the company's job board to be found and its open
 * jobs counted. Public board pages only, and no AI call. The row shows the result when the probe is
 * done; the lists are read again until then.
 */
export function useCheckBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (c: CompanyView) =>
      api<{ jobId: string }>(`/companies/${enc(c.id)}/check-board`, { method: 'POST' }),
    onError: (err) =>
      toast({
        title: 'Board not checked',
        description: checkBoardFailure(err),
        variant: 'destructive',
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['companies'] }),
  });
}

/** The user's correction of a company's industry (#220), which then stands. */
export function useSetCompanyIndustry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, code }: { id: string; code: string }) =>
      api<CompanyView>(`/companies/${enc(id)}/industry`, { method: 'PUT', body: { code } }),
    onError: (err) =>
      toast({
        title: 'Industry not saved',
        description: errorMessage(err),
        variant: 'destructive',
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['companies'] }),
  });
}

/** One row of the user's industry profile (#219). The reason is the model's text. */
export interface IndustryRow {
  code: string;
  title: string;
  tier: NaicsTier;
  source: string;
  reason: string | null;
  confirmed: boolean;
}

const INDUSTRY_PROFILE_URL = '/discovery/industry-profile';
const industryProfileKey = ['discovery', 'industry-profile'] as const;

export function useIndustryProfile() {
  return useQuery({
    queryKey: industryProfileKey,
    queryFn: () => api<{ items: IndustryRow[] }>(INDUSTRY_PROFILE_URL),
  });
}

export function useSuggestIndustries() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<{ suggested: number; items: IndustryRow[] }>(`${INDUSTRY_PROFILE_URL}/suggest`, {
        method: 'POST',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: industryProfileKey }),
  });
}

/** After a change to a row: what failed goes to a toast, and the list is read again either way. */
function useIndustryChange<V>(fn: (vars: V) => Promise<unknown>, failed: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onError: (err) =>
      toast({ title: failed, description: errorMessage(err), variant: 'destructive' }),
    onSettled: () => qc.invalidateQueries({ queryKey: industryProfileKey }),
  });
}

export function useConfirmIndustry() {
  return useIndustryChange(
    (code: string) => api(`${INDUSTRY_PROFILE_URL}/${enc(code)}/confirm`, { method: 'POST' }),
    'Not confirmed',
  );
}

export function useRemoveIndustry() {
  return useIndustryChange(
    (code: string) => api(`${INDUSTRY_PROFILE_URL}/${enc(code)}`, { method: 'DELETE' }),
    'Not removed',
  );
}

export function useAddIndustry() {
  return useIndustryChange(
    (body: { code: string; tier: NaicsTier }) =>
      api(INDUSTRY_PROFILE_URL, { method: 'POST', body }),
    'Not added',
  );
}

/** Follows a company that was never suggested, as accepting a suggestion does: the server
 *  follows it and queues its board detection. A denied company is refused (company_denied). */
export function useFollowCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (c: CompanyView) =>
      api<CompanyView>(`/companies/${enc(c.id)}/follow`, { method: 'POST' }),
    onSuccess: (_res, c) => toast({ title: 'Following', description: c.name, variant: 'success' }),
    onError: (err) =>
      toast({
        title: 'Not followed',
        description:
          err instanceof ApiError && err.code === 'company_denied'
            ? 'That company is denied. Undo the denial first.'
            : errorMessage(err),
        variant: 'destructive',
      }),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['companies'] }),
        qc.invalidateQueries({ queryKey: discoveryKeys.sources }),
      ]),
  });
}

/** Denies a company from the network list. It was never a suggestion, so this sets the status
 *  directly, as the deny-by-name form does; Undo in Denied companies reverses it. */
export function useDenyNetworkCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (c: CompanyView) =>
      api<CompanyView>(`/companies/${enc(c.id)}`, { method: 'PATCH', body: { status: 'denied' } }),
    onSuccess: (_res, c) => toast({ title: 'Denied', description: c.name }),
    onError: (err) =>
      toast({ title: 'Not denied', description: errorMessage(err), variant: 'destructive' }),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['companies'] }),
        qc.invalidateQueries({ queryKey: discoveryKeys.sources }),
      ]),
  });
}

/** What a follow or a deny of several companies did, company by company (#302). */
export interface BulkOutcome {
  done: CompanyView[];
  failed: { company: CompanyView; reason: string }[];
}

/** Why one company in a batch was not followed or denied, in the user's words. */
function bulkFailure(err: unknown): string {
  // The browser's own wording for a request that never reached the server ("Failed to fetch").
  if (err instanceof TypeError)
    return 'Could not reach Opportun. Check your connection and try again.';
  if (err instanceof ApiError && err.code === 'company_denied') {
    return 'That company is denied. Undo the denial first.';
  }
  if (err instanceof ApiError && err.code === 'not_suggested') {
    return 'That company is no longer a pending suggestion.';
  }
  return errorMessage(err);
}

/**
 * Follows or denies several companies one after another, as the one-company routes do (a suggestion
 * is accepted or denied as a suggestion, any other company followed or set to denied): one that
 * fails does not stop the rest, and the result says which did and which did not, with each reason.
 * One toast tells it, not one for each company.
 */
export function useBulkCompanies(action: 'follow' | 'deny') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rows: readonly CompanyView[]): Promise<BulkOutcome> => {
      const outcome: BulkOutcome = { done: [], failed: [] };
      for (const c of rows) {
        const suggestion = c.status === 'suggested';
        try {
          if (action === 'follow') {
            await api<CompanyView>(`/companies/${enc(c.id)}/${suggestion ? 'accept' : 'follow'}`, {
              method: 'POST',
            });
          } else if (suggestion) {
            await api<CompanyView>(`/companies/${enc(c.id)}/deny`, { method: 'POST' });
          } else {
            await api<CompanyView>(`/companies/${enc(c.id)}`, {
              method: 'PATCH',
              body: { status: 'denied' },
            });
          }
          outcome.done.push(c);
        } catch (err) {
          outcome.failed.push({ company: c, reason: bulkFailure(err) });
        }
      }
      return outcome;
    },
    onSuccess: (outcome) => {
      const verb = action === 'follow' ? ['Followed', 'Not followed'] : ['Denied', 'Not denied'];
      const names = outcome.done.map((c) => c.name).join(', ');
      if (outcome.failed.length === 0) {
        toast({
          title: action === 'follow' ? 'Following' : 'Denied',
          description: names,
          variant: action === 'follow' ? 'success' : 'default',
        });
        return;
      }
      const failed = outcome.failed.map((f) => `${f.company.name} (${f.reason})`).join(', ');
      toast({
        title: `${verb[0]} ${outcome.done.length} of ${outcome.done.length + outcome.failed.length}`,
        description: `${outcome.done.length > 0 ? `${verb[0]}: ${names}. ` : ''}${verb[1]}: ${failed}.`,
        variant: 'destructive',
      });
    },
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['companies'] }),
        qc.invalidateQueries({ queryKey: discoveryKeys.sources }),
      ]),
  });
}
