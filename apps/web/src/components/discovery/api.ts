// Discovery data: the review queue (accept, attach, dismiss), the user's sources (CRUD, run now,
// run history) and per-role-target discovery prompts. Shapes mirror
// apps/server/src/routes/discovery.ts and the /role-targets/:id/discovery-prompt routes in
// apps/server/src/routes/profile.ts.
//
// Postings are third-party data (sanitized by the server but untrusted): every component that
// shows one renders its fields as plain text, never as markdown or HTML.
import type {
  DiscoverySourceKind,
  Disposition,
  DismissReason,
  NormalizedPosting,
  Resolution,
} from '@opportun/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { PromptVersion } from '@/components/ai/api';
import { toast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { qk, type Page } from '@/lib/opportunities';

export interface DiscoveryResult {
  id: string;
  runId: string;
  sourceId: string;
  sourceKind: DiscoverySourceKind;
  roleTargetId: string | null;
  posting: NormalizedPosting;
  dedupeKey: string | null;
  /** 0 to 100, or null before (or without) AI ranking. */
  aiScore: number | null;
  aiRationale: string | null;
  resolution: Resolution;
  resolvedSourceRef: string | null;
  disposition: Disposition;
  opportunityId: string | null;
  /**
   * The message this lead was parsed out of (design D3b), as the two identifiers its deep link
   * is built from. Null for a lead that came from a board rather than from mail.
   */
  sourceMailChannel: string | null;
  sourceMailExternalId: string | null;
  /** Why a dismissed result was dismissed (issue #199); null unless disposition is dismissed. */
  dismissReason: string | null;
  dismissNote: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DiscoverySource {
  id: string;
  kind: DiscoverySourceKind;
  config: Record<string, unknown>;
  enabled: boolean;
  scheduleCron: string | null;
  roleTargetId: string | null;
  companyId: string | null;
  lastRunAt: number | null;
  status: 'ok' | 'error';
  statusDetail: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DiscoveryRun {
  id: string;
  sourceId: string;
  roleTargetId: string | null;
  startedAt: number;
  finishedAt: number | null;
  stats: Record<string, unknown> | null;
  error: string | null;
}

export interface SourceInput {
  kind?: DiscoverySourceKind;
  config?: Record<string, unknown>;
  enabled?: boolean;
  scheduleCron?: string | null;
  roleTargetId?: string | null;
}

/** A patch never changes the kind. */
export type SourcePatch = Omit<SourceInput, 'kind'>;

export interface RoleTargetDiscoveryPrompt {
  roleTargetId: string;
  /** The prompt ranking uses for this role target. */
  prompt: PromptVersion;
  /** True when the role target has its own linked version (false: the user's default). */
  linked: boolean;
  /** A pending refinement proposal for this role target. */
  proposal: PromptVersion | null;
}

const enc = encodeURIComponent;

/** The two dispositions the decided-results view (#97) has tabs for. */
export const DECIDED_TABS = ['dismissed', 'accepted'] as const;
export type DecidedTab = (typeof DECIDED_TABS)[number];

export const discoveryKeys = {
  queue: ['discovery', 'results', 'pending'] as const,
  decided: (tab: DecidedTab) => ['discovery', 'results', 'decided', tab] as const,
  sources: ['discovery', 'sources'] as const,
  runs: (sourceId: string) => ['discovery', 'sources', sourceId, 'runs'] as const,
  prompt: (roleTargetId: string) => ['discovery', 'prompt', roleTargetId] as const,
  alertSenders: ['discovery', 'alert-senders'] as const,
};

// --- labels ----------------------------------------------------------------------

const KIND_LABELS = new Map<DiscoverySourceKind, string>([
  ['ats_greenhouse', 'Greenhouse'],
  ['ats_lever', 'Lever'],
  ['ats_ashby', 'Ashby'],
  ['ats_workday', 'Workday'],
  ['mcp', 'MCP'],
  ['alert_email', 'Job alert email'],
  ['manual', 'Manual capture'],
  ['extension', 'Browser extension'],
]);
export const sourceKindLabel = (k: DiscoverySourceKind): string => KIND_LABELS.get(k) ?? k;

const RESOLUTION_LABELS = new Map<Resolution, string>([
  ['full', 'Full posting'],
  ['resolved_ats', 'Resolved on ATS'],
  ['needs_capture', 'Needs capture'],
  ['capture_failed', 'Capture failed'],
]);
export const resolutionLabel = (r: Resolution): string => RESOLUTION_LABELS.get(r) ?? r;

/**
 * ATS kinds take an org slug, except Workday, which takes its career site URL (stored as
 * {host, tenant, site}); MCP takes a command or URL, tool and mapping.
 */
export const ATS_KINDS = ['ats_greenhouse', 'ats_lever', 'ats_ashby', 'ats_workday'] as const;
export type AtsKind = (typeof ATS_KINDS)[number];
export const isAtsKind = (k: DiscoverySourceKind): k is AtsKind =>
  (ATS_KINDS as readonly string[]).includes(k);
/** Kinds the user creates by hand. Alert-email and manual sources are made by the app. */
export const CREATABLE_KINDS = [...ATS_KINDS, 'mcp'] as const;

// --- per-kind config validation (mirrors the server's per-kind config schemas) -----------

export const AtsConfigSchema = z
  .object({
    org: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]{1,100}$/, 'Use the board slug: lowercase letters, digits and hyphens'),
  })
  .strict();

// A Workday board (FR-D10), mirroring apps/server/src/adapters/discoverySource.ts WorkdayConfig
// and the Workday branch of jobs/atsDetect.ts boardFromUrl: the datacenter label (wd1, wd5, wd12)
// is part of the host and is read from the URL, never guessed.
const WORKDAY_HOST = /^([a-z0-9][a-z0-9-]{0,62})\.wd[0-9]{1,3}\.myworkdayjobs\.com$/;
const WORKDAY_SITE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const WORKDAY_LOCALE = /^[a-z]{2}-[A-Z]{2}$/;

export interface WorkdayConfig {
  host: string;
  tenant: string;
  site: string;
}

/** The Workday board a career site or posting URL names, or null when it names none. */
export function workdayConfigFromUrl(raw: string): WorkdayConfig | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const tenant = WORKDAY_HOST.exec(host)?.[1];
  if (tenant === undefined) return null;
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  const site = WORKDAY_LOCALE.test(segments[0] ?? '') ? segments[1] : segments[0];
  if (site === undefined || site === 'wday' || !WORKDAY_SITE.test(site)) return null;
  return { host, tenant, site };
}

// The MCP schema below mirrors apps/server/src/adapters/sources/mcpConfig.ts field for field
// (names, required keys, limits, strictness and messages), so the form accepts exactly what the
// server accepts. Change both together.

const SEGMENT = /^[A-Za-z0-9_$-]{1,100}$/;

/** A dot path: 1 to 16 segments of letters, digits, _, $ or -; numeric segments index arrays. */
export function isMcpPath(path: string): boolean {
  const segments = path.split('.');
  return segments.length <= 16 && segments.every((s) => SEGMENT.test(s));
}
const Path = z.string().max(1700).refine(isMcpPath, { message: 'not a dot path' });

/** https only: the server is reached over the network, so plain http is refused. */
const HttpsUrl = z
  .url()
  .max(2048)
  .refine((u) => new URL(u).protocol === 'https:', { message: 'MCP server URL must be https' });

const McpMappingSchema = z
  .object({
    company: Path,
    title: Path,
    descriptionMd: Path.optional(),
    postingUrl: Path.optional(),
    location: Path.optional(),
    externalId: Path.optional(),
  })
  .strict();

const mcpCommon = {
  // Same limits as the server; only the empty-field messages are worded for the form.
  tool: z.string().min(1, 'Name the tool to call').max(200),
  queryArgs: z
    .record(z.string().min(1).max(100), z.string().max(2000))
    .refine((r) => Object.keys(r).length <= 50, { message: 'at most 50 query arguments' }),
  mapping: McpMappingSchema,
  /** Where the list of results sits in the tool output; empty when the output is the list. */
  itemsPath: z.union([z.literal(''), Path]),
};

const McpStdioConfig = z
  .object({
    transport: z.literal('stdio'),
    command: z.string().min(1, 'stdio needs a command').max(500),
    args: z.array(z.string().max(1000)).max(50),
    ...mcpCommon,
  })
  .strict();

const McpHttpConfig = z
  .object({ transport: z.literal('http'), url: HttpsUrl, ...mcpCommon })
  .strict();

/** An MCP source: how to start or reach the server, which tool to call, how to map its output. */
export const McpConfigSchema = z.discriminatedUnion('transport', [McpStdioConfig, McpHttpConfig]);

/** Parses the MCP config textarea. Returns the config or a list of human-readable problems. */
export function parseMcpConfig(
  text: string,
): { ok: true; config: Record<string, unknown> } | { ok: false; issues: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, issues: [`Not valid JSON: ${err instanceof Error ? err.message : ''}`] };
  }
  const parsed = McpConfigSchema.safeParse(raw);
  if (parsed.success) return { ok: true, config: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) =>
      i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message,
    ),
  };
}

// --- review queue ----------------------------------------------------------------

/** Pending results, best AI score first (the list convention sorts ascending without '-'). */
export function useReviewQueue() {
  return useQuery({
    queryKey: discoveryKeys.queue,
    queryFn: () =>
      api<Page<DiscoveryResult>>('/discovery/results?disposition=pending&sort=-ai_score&limit=200'),
  });
}

export interface AcceptVars {
  id: string;
  attachTo?: string;
  force?: boolean;
}

/** Optimistically drops a result from the queue; the caller's onError decides what to show. */
function useQueueMutation<TVars extends { id: string }>(
  mutationFn: (vars: TVars) => Promise<DiscoveryResult>,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (vars: TVars) => {
      await qc.cancelQueries({ queryKey: discoveryKeys.queue });
      const previous = qc.getQueryData<Page<DiscoveryResult>>(discoveryKeys.queue);
      if (previous !== undefined) {
        qc.setQueryData<Page<DiscoveryResult>>(discoveryKeys.queue, {
          items: previous.items.filter((r) => r.id !== vars.id),
          total: Math.max(0, previous.total - 1),
        });
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous !== undefined) qc.setQueryData(discoveryKeys.queue, context.previous);
    },
    onSettled: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: discoveryKeys.queue }),
        qc.invalidateQueries({ queryKey: qk.opportunities }),
      ]);
    },
  });
}

export function useAcceptResult() {
  return useQueueMutation<AcceptVars>(({ id, attachTo, force }) =>
    api<DiscoveryResult>(`/discovery/results/${enc(id)}/accept`, {
      method: 'POST',
      body: {
        ...(attachTo === undefined ? {} : { attachTo }),
        ...(force === true ? { force: true } : {}),
      },
    }),
  );
}

export interface DismissVars {
  id: string;
  reason?: DismissReason;
  note?: string;
}

export function useDismissResult() {
  return useQueueMutation<DismissVars>(({ id, reason, note }) =>
    api<DiscoveryResult>(`/discovery/results/${enc(id)}/dismiss`, {
      method: 'POST',
      body: {
        ...(reason === undefined ? {} : { reason }),
        ...(note === undefined ? {} : { note }),
      },
    }),
  );
}

// --- bulk triage (#184) ------------------------------------------------------------

/** Mirrors apps/server/src/routes/discovery.ts's BULK_OUTCOMES. */
export const BULK_OUTCOMES = [
  'accepted',
  'dismissed',
  'restored',
  'already_decided',
  'duplicate',
  'not_found',
  'error',
] as const;
export type BulkOutcome = (typeof BULK_OUTCOMES)[number];

export interface BulkItemResult {
  id: string;
  outcome: BulkOutcome;
  existingId?: string;
  message?: string;
}

/** Mirrors the server's MAX_BULK_SIZE (apps/server/src/routes/discovery.ts): a batch over this
 *  is split into sequential requests, so the UI's own selection cap never has to match it. */
export const MAX_BULK_SIZE = 100;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Progress through a chunked bulk request: how many ids have a result back, out of how many
 *  were submitted. */
export type BulkProgress = { done: number; total: number };

/** Runs ids through a bulk endpoint in MAX_BULK_SIZE-sized requests, concatenating the
 *  per-item results in order so the caller sees one flat outcome list regardless of size.
 *  `onProgress` fires after each request settles, so a selection larger than one chunk shows
 *  visible progress rather than one silent wait (#184). */
async function bulkRequest(
  path: string,
  ids: readonly string[],
  extra: Record<string, unknown> = {},
  onProgress?: (p: BulkProgress) => void,
): Promise<BulkItemResult[]> {
  const results: BulkItemResult[] = [];
  for (const batch of chunk(ids, MAX_BULK_SIZE)) {
    const res = await api<{ results: BulkItemResult[] }>(path, {
      method: 'POST',
      body: { ids: batch, ...extra },
    });
    results.push(...res.results);
    onProgress?.({ done: results.length, total: ids.length });
  }
  return results;
}

/**
 * Not optimistic (design principle 6): per-item outcomes vary (accepted, duplicate,
 * already-decided, not found, error), so there is nothing honest to assume before the server
 * answers. The caller builds its own summary from the real results and the queue refetches.
 */
function useBulkMutation<TVars>(mutationFn: (vars: TVars) => Promise<BulkItemResult[]>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: discoveryKeys.queue }),
        qc.invalidateQueries({ queryKey: qk.opportunities }),
      ]);
    },
  });
}

export interface BulkAcceptVars {
  ids: string[];
  onProgress?: (p: BulkProgress) => void;
}

export function useBulkAccept() {
  return useBulkMutation<BulkAcceptVars>(({ ids, onProgress }) =>
    bulkRequest('/discovery/results/bulk-accept', ids, {}, onProgress),
  );
}

export interface BulkDismissVars {
  ids: string[];
  reason: DismissReason;
  note?: string;
  onProgress?: (p: BulkProgress) => void;
}

export function useBulkDismiss() {
  return useBulkMutation<BulkDismissVars>(({ ids, reason, note, onProgress }) =>
    bulkRequest(
      '/discovery/results/bulk-dismiss',
      ids,
      { reason, ...(note === undefined ? {} : { note }) },
      onProgress,
    ),
  );
}

export interface BulkUndoVars {
  ids: string[];
  onProgress?: (p: BulkProgress) => void;
}

export function useBulkUndoDismiss() {
  return useBulkMutation<BulkUndoVars>(({ ids, onProgress }) =>
    bulkRequest('/discovery/results/bulk-undo-dismiss', ids, {}, onProgress),
  );
}

/**
 * Every pending result's id, not just what the queue keeps loaded (#184's "select all N
 * matching"): paginates past the single request's MAX_LIMIT (200, routes/common.ts) when more
 * results exist than that.
 */
export async function fetchAllPendingResultIds(): Promise<string[]> {
  const limit = 200;
  let offset = 0;
  const ids: string[] = [];
  for (;;) {
    const page = await api<Page<DiscoveryResult>>(
      `/discovery/results?disposition=pending&sort=-ai_score&limit=${limit}&offset=${offset}`,
    );
    ids.push(...page.items.map((r) => r.id));
    if (ids.length >= page.total || page.items.length < limit) break;
    offset += limit;
  }
  return ids;
}

// --- decided results (#97), accepted or dismissed, best source for unsuppress (#96) ----------

/** A disposition's decided results, most recently decided first. */
export function useDecidedResults(tab: DecidedTab) {
  return useQuery({
    queryKey: discoveryKeys.decided(tab),
    queryFn: () =>
      api<Page<DiscoveryResult>>(`/discovery/results?disposition=${tab}&sort=-updatedAt&limit=200`),
  });
}

/**
 * Releases a decided result's dedupe key (#96) so a later repost is evaluated fresh instead of
 * suppressed forever. Not optimistic: the result stays in its tab either way, and the server's
 * response (not a guess) is what flips a row from "Unsuppress" to the "Unsuppressed" badge
 * (design principle 6), written into both decided tabs' caches since a row never moves tabs.
 */
export function useUnsuppressResult() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<DiscoveryResult>(`/discovery/results/${enc(id)}/unsuppress`, { method: 'POST' }),
    onSuccess: (updated) => {
      for (const tab of DECIDED_TABS) {
        qc.setQueryData<Page<DiscoveryResult>>(discoveryKeys.decided(tab), (prev) =>
          prev === undefined
            ? prev
            : { ...prev, items: prev.items.map((r) => (r.id === updated.id ? updated : r)) },
        );
      }
    },
  });
}

// --- manual capture --------------------------------------------------------------

/** Exactly one of url or text; resultId completes that needs_capture lead in place. */
export type CaptureVars = ({ url: string } | { text: string }) & { resultId?: string };

export interface CaptureResponse {
  posting: NormalizedPosting;
  resultId: string;
}

/** POST /capture: the posting enters (or completes a lead in) the review queue. */
export function useCapture() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CaptureVars) => api<CaptureResponse>('/capture', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: discoveryKeys.queue }),
  });
}

// --- sources ---------------------------------------------------------------------

export function useSources() {
  return useQuery({
    queryKey: discoveryKeys.sources,
    queryFn: () => api<Page<DiscoverySource>>('/discovery/sources?limit=200&sort=-createdAt'),
  });
}

export function useCreateSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SourceInput) =>
      api<DiscoverySource>('/discovery/sources', { method: 'POST', body }),
    onSettled: () => qc.invalidateQueries({ queryKey: discoveryKeys.sources }),
  });
}

/** Optimistic patch (enable/disable flips at once; rolled back with a toast on error). */
export function useUpdateSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: SourcePatch }) =>
      api<DiscoverySource>(`/discovery/sources/${enc(id)}`, { method: 'PATCH', body: patch }),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: discoveryKeys.sources });
      const previous = qc.getQueryData<Page<DiscoverySource>>(discoveryKeys.sources);
      if (previous !== undefined) {
        qc.setQueryData<Page<DiscoverySource>>(discoveryKeys.sources, {
          ...previous,
          items: previous.items.map((s) => (s.id === id ? { ...s, ...patch } : s)),
        });
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous !== undefined) qc.setQueryData(discoveryKeys.sources, context.previous);
      toast({ title: 'Source not saved', description: errorMessage(err), variant: 'destructive' });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: discoveryKeys.sources }),
  });
}

export function useDeleteSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/discovery/sources/${enc(id)}`, { method: 'DELETE' }),
    onError: (err) =>
      toast({
        title: 'Source not removed',
        description: errorMessage(err),
        variant: 'destructive',
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: discoveryKeys.sources }),
  });
}

/** Run now: enqueues a run (the server dedupes while one is unfinished). */
export function useRunSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ jobId: string }>(`/discovery/sources/${enc(id)}/run`, { method: 'POST' }),
    onSuccess: (_res, id) => qc.invalidateQueries({ queryKey: discoveryKeys.runs(id) }),
  });
}

export function useSourceRuns(sourceId: string | null) {
  return useQuery({
    queryKey: discoveryKeys.runs(sourceId ?? ''),
    queryFn: () =>
      api<Page<DiscoveryRun>>(
        `/discovery/sources/${enc(sourceId ?? '')}/runs?limit=50&sort=-startedAt`,
      ),
    enabled: sourceId !== null,
  });
}

// --- alert senders (issue #15) ----------------------------------------------------

export interface AlertSendersState {
  senders: string[];
  /** False once the user has configured anything, even an empty list (design principle 6). */
  usingDefaults: boolean;
  defaults: string[];
}

export function useAlertSenders() {
  return useQuery({
    queryKey: discoveryKeys.alertSenders,
    queryFn: () => api<AlertSendersState>('/settings/alert-senders'),
  });
}

/**
 * Not optimistic: this list decides which mail becomes a lead, same reasoning as the mail
 * filter rules — showing it saved before the server agrees would misstate the one thing this
 * editor exists to be precise about. `senders: null` resets to the defaults.
 */
export function useSetAlertSenders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (senders: string[] | null) =>
      api<AlertSendersState>('/settings/alert-senders', { method: 'PATCH', body: { senders } }),
    onError: (err) =>
      toast({
        title: 'Alert senders not saved',
        description: errorMessage(err),
        variant: 'destructive',
      }),
    onSuccess: (data) => qc.setQueryData(discoveryKeys.alertSenders, data),
    onSettled: () => qc.invalidateQueries({ queryKey: discoveryKeys.alertSenders }),
  });
}

// --- per-role-target discovery prompt -------------------------------------------------

export function useRoleTargetPrompt(roleTargetId: string | null) {
  return useQuery({
    queryKey: discoveryKeys.prompt(roleTargetId ?? ''),
    queryFn: () =>
      api<RoleTargetDiscoveryPrompt>(`/role-targets/${enc(roleTargetId ?? '')}/discovery-prompt`),
    enabled: roleTargetId !== null,
  });
}

function usePromptMutation<TVars>(
  roleTargetId: string,
  mutationFn: (vars: TVars) => Promise<unknown>,
  errorTitle: string,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onError: (err) =>
      toast({ title: errorTitle, description: errorMessage(err), variant: 'destructive' }),
    onSettled: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: discoveryKeys.prompt(roleTargetId) }),
        qc.invalidateQueries({ queryKey: ['ai', 'prompts', 'discovery.rank'] }),
      ]);
    },
  });
}

/** Edit from the role target: a new version, linked to this role target only. */
export function useEditRoleTargetPrompt(roleTargetId: string) {
  return usePromptMutation(
    roleTargetId,
    (body: string) =>
      api<RoleTargetDiscoveryPrompt>(`/role-targets/${enc(roleTargetId)}/discovery-prompt`, {
        method: 'POST',
        body: { body },
      }),
    'Version not saved',
  );
}

/** Points the role target at a version (activate), or back to the default with null (reset). */
export function useLinkRoleTargetPrompt(roleTargetId: string) {
  return usePromptMutation(
    roleTargetId,
    (promptId: string | null) =>
      api<RoleTargetDiscoveryPrompt>(`/role-targets/${enc(roleTargetId)}/discovery-prompt`, {
        method: 'PUT',
        body: { promptId },
      }),
    'Version not activated',
  );
}

/** Accepting a role target's proposal links it to that role target (server side). */
export function useAcceptRoleTargetProposal(roleTargetId: string) {
  return usePromptMutation(
    roleTargetId,
    (id: string) =>
      api<PromptVersion>(`/ai/prompts/${enc(id)}/accept-proposal`, { method: 'POST' }),
    'Proposal not accepted',
  );
}

export function useDiscardRoleTargetProposal(roleTargetId: string) {
  return usePromptMutation(
    roleTargetId,
    (id: string) => api<void>(`/ai/prompts/${enc(id)}/discard-proposal`, { method: 'POST' }),
    'Proposal not discarded',
  );
}
