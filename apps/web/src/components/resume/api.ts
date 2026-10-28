// Resume workspace data: resumes, tailoring sessions (with the SSE chat stream), match
// reports, the Google connection and the Reactive Resume connection (FR-R7).
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, CSRF_COOKIE, API_BASE, readCookie } from '@/lib/api';

const enc = encodeURIComponent;

export const RESUME_STATUSES = ['draft', 'in_review', 'final', 'submitted'] as const;
export type ResumeStatus = (typeof RESUME_STATUSES)[number];

const STATUS_LABELS = new Map<ResumeStatus, string>([
  ['draft', 'Draft'],
  ['in_review', 'In review'],
  ['final', 'Final'],
  ['submitted', 'Submitted'],
]);

export function statusLabel(status: ResumeStatus): string {
  return STATUS_LABELS.get(status) ?? status;
}

export interface Resume {
  id: string;
  kind: 'base' | 'tailored';
  opportunityId: string | null;
  title: string;
  store: 'google_doc' | 'local_file' | 'reactive_resume';
  docRef: string;
  url: string | null;
  parentResumeId: string | null;
  status: ResumeStatus;
  submittedAt: number | null;
  submittedTo: string | null;
  /** Set instead of a hard delete when a submitted resume is removed (#70). */
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Edit {
  find: string;
  replace: string;
  rationale?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  at: number;
  edits: Edit[];
  incomplete: boolean;
}

export interface TailoringSession {
  id: string;
  resumeId: string;
  acceptedAt: number | null;
  createdAt: number;
  messages: ChatMessage[];
}

export interface MatchReport {
  score: number;
  missingKeywords: string[];
  weakAreas: { area: string; suggestion: string }[];
  summary: string;
}

/**
 * A stored report, dated and flagged for currency (#175): `stale` is true once a tailoring
 * session has completed for the resume since `scoredAt`, so the score may no longer describe
 * the document on screen. A client should say that, not imply the score is still current.
 */
export interface MatchReportView {
  report: MatchReport;
  scoredAt: number;
  stale: boolean;
}

/** The last check of the saved OAuth client (format, then a live probe at Google). */
export interface GoogleClientValidation {
  ok: boolean;
  status: 'valid' | 'invalid' | 'unverified';
  error?: string;
  fix?: string;
  warning?: string;
  checkedAt: number;
}

export interface GoogleStatus {
  connected: boolean;
  scopes: string[];
  email?: string;
  clientConfigured: boolean;
  /** The stored OAuth client id (public identifier); the secret never comes back. */
  clientId: string | null;
  /** The exact redirect URI to register, as the server computes it from BASE_URL. */
  redirectUri: string;
  /** The authorized JavaScript origin to register. */
  jsOrigin: string;
  /** The redirect URI "Sign in with Google" sends; register it too when sign-in reuses this client. */
  signInRedirectUri: string;
  /** Whether the user has an AI key (the diagnose assist needs one). */
  aiAvailable: boolean;
  validation: GoogleClientValidation | null;
}

/** The Reactive Resume connection. The API key itself never comes back. */
export interface ReactiveResumeStatus {
  baseUrl: string | null;
  keySet: boolean;
  connected: boolean;
  /** Reactive Resume releases the integration was written against, e.g. ["6.0"]. */
  targetVersions: string[];
}

export interface ReactiveResumeValidation {
  ok: boolean;
  version: string | null;
  error: string | null;
}

/** Where new base resumes are registered. Existing resumes keep their own store. */
export type DocumentStorePref = 'google' | 'reactive_resume';

export const rk = {
  resumes: ['resumes'] as const,
  list: (params: { opportunityId?: string; kind?: string }) => ['resumes', 'list', params] as const,
  resume: (id: string) => ['resumes', 'one', id] as const,
  session: (resumeId: string) => ['tailoring', resumeId] as const,
  match: (resumeId: string, opportunityId: string) =>
    ['resumes', 'match', resumeId, opportunityId] as const,
  text: (resumeId: string) => ['resumes', 'text', resumeId] as const,
  google: ['integrations', 'google'] as const,
  reactiveResume: ['integrations', 'reactive-resume'] as const,
  documentStore: ['settings', 'document-store'] as const,
  namingTemplate: ['settings', 'resume-naming-template'] as const,
  driveSearch: (q: string) => ['resumes', 'drive-search', q] as const,
};

export function useResumes(params: { opportunityId?: string; kind?: 'base' | 'tailored' } = {}) {
  const search = new URLSearchParams({ limit: '200' });
  if (params.opportunityId !== undefined) search.set('opportunityId', params.opportunityId);
  if (params.kind !== undefined) search.set('kind', params.kind);
  return useQuery({
    queryKey: rk.list(params),
    queryFn: () => api<{ items: Resume[]; total: number }>(`/resumes?${search.toString()}`),
  });
}

export function useResume(id: string) {
  return useQuery({
    queryKey: rk.resume(id),
    queryFn: () => api<Resume>(`/resumes/${enc(id)}`),
  });
}

export type CreateResumeInput =
  | { store: 'google_doc' | 'reactive_resume'; docRef: string; opportunityId?: string }
  | { baseResumeId: string; opportunityId: string };

/** One Google Doc found by the Drive search picker (#136). */
export interface DriveSearchHit {
  id: string;
  name: string;
  modifiedTime: string;
  folderName: string | null;
}
interface DriveSearchPage {
  files: DriveSearchHit[];
  nextPageToken?: string;
}

/**
 * Searches the caller's Drive for Google Docs by name, newest first; an empty query returns
 * recently modified documents. Pages through the server's own opaque pageToken.
 */
export function useDriveSearch(q: string, opts: { enabled: boolean }) {
  const term = q.trim();
  return useInfiniteQuery({
    queryKey: rk.driveSearch(term),
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams({ limit: '20' });
      if (term !== '') search.set('q', term);
      if (pageParam !== undefined) search.set('pageToken', pageParam);
      return api<DriveSearchPage>(`/resumes/drive-search?${search.toString()}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextPageToken,
    enabled: opts.enabled,
  });
}

export function useCreateResume() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateResumeInput) => api<Resume>('/resumes', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: rk.resumes }),
  });
}

export interface ResumePatch {
  status?: ResumeStatus;
  submittedTo?: string;
}

export function useUpdateResume(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: ResumePatch) =>
      api<Resume>(`/resumes/${enc(id)}`, { method: 'PATCH', body: patch }),
    onSuccess: (r) => {
      qc.setQueryData(rk.resume(id), r);
      return qc.invalidateQueries({ queryKey: rk.resumes });
    },
  });
}

/**
 * Attach (an opportunity id), detach (null) or move (a different id) a resume's link (#77).
 * Not keyed to one resume id upfront like useUpdateResume, since the attach picker doesn't
 * know which resume until the person chooses one.
 */
export function useAttachResume() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, opportunityId }: { id: string; opportunityId: string | null }) =>
      api<Resume>(`/resumes/${enc(id)}`, { method: 'PATCH', body: { opportunityId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: rk.resumes }),
  });
}

/**
 * The server decides archive vs. delete (a submitted resume is archived, never deleted) and
 * reports which one happened; this result is what callers should tell the person, not a
 * prediction made from the resume's status before the request went out (#70, #75).
 */
export type DeleteResumeResult = { outcome: 'deleted' } | { outcome: 'archived'; resume: Resume };

export function useDeleteResume() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<DeleteResumeResult>(`/resumes/${enc(id)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: rk.resumes }),
  });
}

/** Opens (or resumes) the resume's tailoring session. */
export function useTailoringSession(resumeId: string) {
  return useQuery({
    queryKey: rk.session(resumeId),
    queryFn: () => api<TailoringSession>(`/resumes/${enc(resumeId)}/tailoring`, { method: 'POST' }),
  });
}

/** 'applied': this edit changed the document. 'already_consumed': its find text existed when
 *  the request was sent, but another edit applied in the same session already changed it
 *  first, so there was nothing left for this one to do (issue #146). */
export type ApplyEditOutcome = 'applied' | 'already_consumed';

export function useApplyEdit(sessionId: string) {
  return useMutation({
    mutationFn: async (edit: Edit): Promise<ApplyEditOutcome> => {
      const res = await api<{ results: { index: number; outcome: ApplyEditOutcome }[] }>(
        `/tailoring/${enc(sessionId)}/suggestions/apply`,
        { method: 'POST', body: { edits: [{ find: edit.find, replace: edit.replace }] } },
      );
      return res.results[0]!.outcome;
    },
  });
}

export function useCompleteSession(resumeId: string, sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<TailoringSession>(`/tailoring/${enc(sessionId)}/complete`, { method: 'POST' }),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: rk.session(resumeId) }),
        qc.invalidateQueries({ queryKey: rk.resumes }),
      ]),
  });
}

/**
 * The resume's stored match report for the opportunity it is linked to, if it has one. A
 * query, not a mutation (#175): the score was computed once and kept, so leaving and coming
 * back must still show it, not just whatever the last `useScoreMatch` call happened to hold.
 */
export function useMatchReport(resumeId: string, opportunityId: string | null) {
  return useQuery({
    queryKey: rk.match(resumeId, opportunityId ?? ''),
    queryFn: () =>
      api<MatchReportView | null>(
        `/resumes/${enc(resumeId)}/match?opportunityId=${enc(opportunityId ?? '')}`,
      ),
    enabled: opportunityId !== null,
  });
}

/** Scores the resume against its opportunity and stores the result (#175). */
export function useScoreMatch(resumeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (opportunityId: string) =>
      api<MatchReportView>(`/resumes/${enc(resumeId)}/match`, {
        method: 'POST',
        body: { opportunityId },
      }),
    onSuccess: (view, opportunityId) => qc.setQueryData(rk.match(resumeId, opportunityId), view),
  });
}

/**
 * The document's own text (issue #321): the only store this is rendered for is one whose
 * resume has no external URL (ResumeWorkspace decides that, not here), which for local_file
 * is lossless -- the stored content already is plain text -- and for a Google Doc or Reactive
 * Resume document is exactly the case already covered by its own "Open in ___" link instead.
 */
export function useResumeText(resumeId: string) {
  return useQuery({
    queryKey: rk.text(resumeId),
    queryFn: () => api<{ text: string }>(`/resumes/${enc(resumeId)}/text`).then((r) => r.text),
  });
}

export function useGoogleStatus() {
  return useQuery({
    queryKey: rk.google,
    queryFn: () => api<GoogleStatus>('/integrations/google'),
  });
}

export function useReactiveResumeStatus() {
  return useQuery({
    queryKey: rk.reactiveResume,
    queryFn: () => api<ReactiveResumeStatus>('/integrations/reactive-resume'),
  });
}

export function useDocumentStore() {
  return useQuery({
    queryKey: rk.documentStore,
    queryFn: () => api<{ store: DocumentStorePref }>('/settings/document-store'),
  });
}

export function useSaveReactiveResume() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { baseUrl: string; apiKey?: string }) =>
      api<ReactiveResumeStatus>('/integrations/reactive-resume', { method: 'PUT', body }),
    onSuccess: (data) => qc.setQueryData(rk.reactiveResume, data),
  });
}

export function useValidateReactiveResume() {
  return useMutation({
    mutationFn: () =>
      api<ReactiveResumeValidation>('/integrations/reactive-resume/validate', { method: 'POST' }),
  });
}

export function useDisconnectReactiveResume() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>('/integrations/reactive-resume', { method: 'DELETE' }),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: rk.reactiveResume }),
        qc.invalidateQueries({ queryKey: rk.documentStore }),
      ]),
  });
}

export function useSetDocumentStore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (store: DocumentStorePref) =>
      api<{ store: DocumentStorePref }>('/settings/document-store', {
        method: 'PUT',
        body: { store },
      }),
    onSuccess: (data) => qc.setQueryData(rk.documentStore, data),
  });
}

/** Plain-language result of the Validate button. */
export function rrValidationMessage(v: ReactiveResumeValidation): string {
  if (v.ok) return `Connected to Reactive Resume ${v.version ?? ''}`.trim() + '.';
  switch (v.error) {
    case 'unauthorized':
      return 'Reactive Resume rejected the API key. Create a new key there and save it here.';
    case 'not_reactive_resume':
      return 'That address did not answer like a Reactive Resume instance.';
    case 'unhealthy':
      return 'Reactive Resume answered, but reports itself unhealthy.';
    case 'unreachable':
      return 'Reactive Resume could not be reached. It must be served over https at a public address.';
    default:
      return 'Reactive Resume answered with an unexpected error.';
  }
}

// --- SSE chat stream --------------------------------------------------------

export type ChatEvent =
  | { type: 'start'; message: ChatMessage }
  | { type: 'delta'; text: string }
  | { type: 'done'; message: ChatMessage }
  | { type: 'error'; code: string; reason: string; keyHint?: string };

/**
 * Splits an SSE byte stream into events. Returns the complete events in `buffer` and the
 * unfinished remainder to prepend to the next chunk.
 */
export function parseSse(buffer: string): { events: ChatEvent[]; rest: string } {
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';
  const events: ChatEvent[] = [];
  for (const block of blocks) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data.length === 0) continue;
    try {
      events.push(JSON.parse(data) as ChatEvent);
    } catch {
      // A malformed event is skipped; the final transcript is refetched anyway.
    }
  }
  return { events, rest };
}

/**
 * Posts a chat message and reads the SSE reply with a fetch reader (EventSource cannot
 * POST or send the CSRF header). Non-2xx answers throw ApiError like api() does.
 */
export async function streamMessage(
  sessionId: string,
  content: string,
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const headers: Record<string, string> = {
    accept: 'text/event-stream',
    'content-type': 'application/json',
  };
  const csrf = readCookie(CSRF_COOKIE);
  if (csrf !== undefined) headers['x-csrf-token'] = csrf;
  const res = await fetch(`${API_BASE}/tailoring/${enc(sessionId)}/messages`, {
    method: 'POST',
    headers,
    credentials: 'same-origin',
    body: JSON.stringify({ content }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!res.ok || res.body === null) {
    let code = `http_${res.status}`;
    let details: Record<string, unknown> = {};
    try {
      const body = (await res.json()) as { error?: { code?: string } & Record<string, unknown> };
      if (typeof body.error?.code === 'string') {
        const { code: c, ...rest } = body.error;
        code = c as string;
        details = rest;
      }
    } catch {
      // Not JSON: keep the status code.
    }
    throw new ApiError(res.status, code, undefined, undefined, details);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSse(buffer);
    buffer = parsed.rest;
    parsed.events.forEach(onEvent);
  }
  parseSse(`${buffer}\n\n`).events.forEach(onEvent);
}

/** The prose of a reply that may still be streaming its trailing json block. */
export function visibleProse(text: string): string {
  const fence = text.indexOf('```json');
  return (fence === -1 ? text : text.slice(0, fence)).trim();
}

/** Messages for the common error codes of this area. */
export function resumeErrorMessage(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  switch (err.code) {
    case 'edit_target_missing':
      return 'That text is no longer in the document. It may already be changed.';
    case 'edit_spans_paragraphs':
      return 'This edit spans several paragraphs; apply it by hand in Google Docs.';
    case 'google_not_connected':
    case 'google_not_configured':
      return 'Connect your Google account in Settings > Integrations first.';
    case 'google_reauth_required':
      return 'Google access has expired. Reconnect in Settings > Integrations.';
    case 'google_scope_missing':
      return 'Google Docs access was not granted. Reconnect in Settings > Integrations.';
    case 'google_doc_unavailable':
      return 'That document could not be opened with your Google account.';
    case 'invalid_doc_ref':
      return 'Paste a Google Docs link or document id (or, for Reactive Resume, a builder link or resume id).';
    case 'edit_spans_formatting':
      return 'This edit crosses bold, italic or link formatting; apply it by hand in Reactive Resume.';
    case 'reactive_resume_not_connected':
      return 'Connect Reactive Resume in Settings > Integrations first.';
    case 'reactive_resume_unauthorized':
      return 'Reactive Resume rejected the API key. Save a new key in Settings > Integrations.';
    case 'reactive_resume_unavailable':
      return 'That resume could not be opened with your Reactive Resume API key.';
    case 'reactive_resume_locked':
      return 'The resume is locked in Reactive Resume. Unlock it there, then try again.';
    case 'reactive_resume_conflict':
      return 'The resume changed in Reactive Resume meanwhile. Try again.';
    case 'reactive_resume_unreachable':
      return 'Reactive Resume could not be reached at the configured address.';
    case 'submitted_to_required':
      return 'Say where the resume was submitted.';
    case 'base_cannot_attach':
      return "A base resume can't be attached directly. Use Create tailored copy instead.";
    case 'ai_unavailable':
      return aiReason(
        String(err.details.reason ?? ''),
        typeof err.details.keyHint === 'string' ? err.details.keyHint : undefined,
      );
    default:
      return undefined;
  }
}

/** `keyHint` (server-built, e.g. "the stored key expired on 2026-05-01") is appended when set. */
export function aiReason(reason: string, keyHint?: string): string {
  const base = baseAiReason(reason);
  return keyHint === undefined || keyHint === '' ? base : `${base} (${keyHint})`;
}

function baseAiReason(reason: string): string {
  switch (reason) {
    case 'no_key':
      return 'No API key for the AI provider. Add one in Settings > AI.';
    case 'budget_exceeded':
      return "Today's AI budget for this task is used up.";
    case 'invalid_output':
      return 'The model returned an unusable answer. Try again.';
    default:
      return 'The AI provider failed. Your message is saved; try again.';
  }
}
