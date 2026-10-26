// AI settings data: model policies, usage, and prompt versions. Policy edits are optimistic
// (cache first, rollback with a toast on error, refetch after). Prompt saves and activations
// wait for the server, since the version number and active flag are decided there.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@/components/ui/toast';
import { onboardingKey } from '@/components/tour/api';
import { api, errorMessage } from '@/lib/api';

export const PROVIDERS = ['anthropic', 'openai', 'openai_compatible'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

const PROVIDER_LABELS = new Map<string, string>([
  ['anthropic', 'Anthropic'],
  ['openai', 'OpenAI'],
  ['openai_compatible', 'OpenAI-compatible'],
]);

/** Display name for a provider id; anything else is shown as given. */
export function providerLabel(id: string): string {
  return PROVIDER_LABELS.get(id) ?? id;
}

export const isProvider = (id: string): id is ProviderId =>
  (PROVIDERS as readonly string[]).includes(id);

export interface ModelPolicy {
  provider: ProviderId;
  model: string;
  maxOutputTokens: number;
  temperature?: number;
  baseUrl?: string;
  /** USD per million input tokens; overrides the server's price table. */
  inputUsdPerMTok?: number;
  /** USD per million output tokens; overrides the server's price table. */
  outputUsdPerMTok?: number;
}

export interface TaskPolicy {
  taskKey: string;
  description: string;
  defaultPolicy: ModelPolicy;
  override: ModelPolicy | null;
}

export interface PoliciesResponse {
  items: TaskPolicy[];
  budget: { perTaskDailyUsd: number };
}

export interface UsageMetrics {
  taskKey: string;
  runs: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
  /** Some runs used the fallback price because the model has no list price. */
  estimated: boolean;
}

export interface UsageResponse {
  days: number;
  items: (UsageMetrics & { day: string })[];
  totals: UsageMetrics[];
}

export interface ModelCheck {
  model: string;
  ok: boolean;
  error: string | null;
}

/** The server's last check of a provider key. Error strings come from providers: text only. */
export interface KeyValidation {
  ok: boolean;
  provider: string;
  models: ModelCheck[];
  /** Always null today: no provider exposes a key's expiry to the key itself. */
  expiresAt: number | null;
  checkedAt: number;
  error: string | null;
}

export interface AiKey {
  id: string;
  /** The provider id (how AI calls find the key). */
  label: string;
  displayName: string | null;
  /** User-entered expiry (epoch ms, UTC midnight of the chosen date). */
  expiresAt: number | null;
  createdAt: number;
  validation: KeyValidation | null;
}

export interface CreatedKey {
  id: string;
  label: string;
  displayName: string | null;
  expiresAt: number | null;
  createdAt: number;
  validation?: KeyValidation;
}

export interface PromptVersion {
  id: string;
  taskKey: string;
  name: string;
  body: string;
  version: number;
  parentId: string | null;
  isActive: boolean;
  isSystem: boolean;
  /** A refinement proposed from the user's corrections, awaiting accept or discard. */
  proposed: boolean;
  proposalSummary: string | null;
  createdAt: number;
}

const enc = encodeURIComponent;

export const aiKeys = {
  keys: ['ai', 'keys'] as const,
  policies: ['ai', 'policies'] as const,
  usage: (days: number) => ['ai', 'usage', days] as const,
  prompts: (taskKey: string) => ['ai', 'prompts', taskKey] as const,
};

// --- provider keys -------------------------------------------------------------

export function useAiKeys() {
  return useQuery({
    queryKey: aiKeys.keys,
    queryFn: () => api<{ items: AiKey[] }>('/ai/keys'),
    select: (data) => data.items,
  });
}

/** Keys live in the secrets vault too: keep both caches in step. */
function useInvalidateKeys() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: aiKeys.keys }),
      qc.invalidateQueries({ queryKey: ['secrets'] }),
      // The setup checklist's AI key item (FR-U12).
      qc.invalidateQueries({ queryKey: onboardingKey }),
    ]);
}

export function useCreateAiKey() {
  const invalidate = useInvalidateKeys();
  // Not optimistic: the value must reach the vault before the key is shown as stored.
  return useMutation({
    mutationFn: (body: {
      label: string;
      value: string;
      displayName?: string;
      expiresAt?: number | null;
    }) => api<CreatedKey>('/secrets', { method: 'POST', body: { kind: 'ai_api_key', ...body } }),
    onSettled: invalidate,
  });
}

export function useValidateKey() {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: (id: string) =>
      api<KeyValidation>(`/ai/keys/${enc(id)}/validate`, { method: 'POST' }),
    onError: (err) =>
      toast({ title: 'Key not checked', description: errorMessage(err), variant: 'destructive' }),
    onSettled: invalidate,
  });
}

export function useUpdateKeyMeta() {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: { displayName: string | null; expiresAt: number | null };
    }) => api<unknown>(`/secrets/${enc(id)}`, { method: 'PATCH', body: patch }),
    onError: (err) =>
      toast({ title: 'Key not updated', description: errorMessage(err), variant: 'destructive' }),
    onSettled: invalidate,
  });
}

export function useDeleteAiKey() {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/secrets/${enc(id)}`, { method: 'DELETE' }),
    onError: (err) =>
      toast({ title: 'Key not removed', description: errorMessage(err), variant: 'destructive' }),
    onSettled: invalidate,
  });
}

// --- policies ------------------------------------------------------------------

export function usePolicies() {
  return useQuery({
    queryKey: aiKeys.policies,
    queryFn: () => api<PoliciesResponse>('/ai/policies'),
  });
}

function usePolicyMutation<TVars>(opts: {
  mutationFn: (vars: TVars) => Promise<unknown>;
  taskKeyOf: (vars: TVars) => string;
  overrideOf: (vars: TVars) => ModelPolicy | null;
  errorTitle: string;
}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: opts.mutationFn,
    onMutate: async (vars: TVars) => {
      await qc.cancelQueries({ queryKey: aiKeys.policies });
      const previous = qc.getQueryData<PoliciesResponse>(aiKeys.policies);
      if (previous !== undefined) {
        const taskKey = opts.taskKeyOf(vars);
        qc.setQueryData<PoliciesResponse>(aiKeys.policies, {
          ...previous,
          items: previous.items.map((i) =>
            i.taskKey === taskKey ? { ...i, override: opts.overrideOf(vars) } : i,
          ),
        });
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous !== undefined) qc.setQueryData(aiKeys.policies, context.previous);
      toast({ title: opts.errorTitle, description: errorMessage(err), variant: 'destructive' });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: aiKeys.policies }),
  });
}

export function useSavePolicy() {
  return usePolicyMutation<{ taskKey: string; policy: ModelPolicy }>({
    mutationFn: ({ taskKey, policy }) =>
      api<TaskPolicy>(`/ai/policies/${enc(taskKey)}`, { method: 'PUT', body: policy }),
    taskKeyOf: (v) => v.taskKey,
    overrideOf: (v) => v.policy,
    errorTitle: 'Model policy not saved',
  });
}

export function useResetPolicy() {
  return usePolicyMutation<string>({
    mutationFn: (taskKey) => api<void>(`/ai/policies/${enc(taskKey)}`, { method: 'DELETE' }),
    taskKeyOf: (taskKey) => taskKey,
    overrideOf: () => null,
    errorTitle: 'Model policy not reset',
  });
}

// --- usage ---------------------------------------------------------------------

export function useUsage(days: number) {
  return useQuery({
    queryKey: aiKeys.usage(days),
    queryFn: () => api<UsageResponse>(`/ai/usage?days=${days}`),
  });
}

// --- prompts -------------------------------------------------------------------

export function usePromptVersions(taskKey: string) {
  return useQuery({
    queryKey: aiKeys.prompts(taskKey),
    queryFn: () => api<{ items: PromptVersion[] }>(`/ai/prompts?taskKey=${enc(taskKey)}`),
    select: (data) => data.items,
  });
}

export function useCreatePromptVersion(taskKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      api<PromptVersion>('/ai/prompts', { method: 'POST', body: { taskKey, body } }),
    onError: (err) =>
      toast({ title: 'Version not saved', description: errorMessage(err), variant: 'destructive' }),
    onSettled: () => qc.invalidateQueries({ queryKey: aiKeys.prompts(taskKey) }),
  });
}

export function useActivatePrompt(taskKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<PromptVersion>(`/ai/prompts/${enc(id)}/activate`, { method: 'POST' }),
    onError: (err) =>
      toast({
        title: 'Version not activated',
        description: errorMessage(err),
        variant: 'destructive',
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: aiKeys.prompts(taskKey) }),
  });
}

// --- proposed refinements ------------------------------------------------------------

export function useAcceptProposal(taskKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<PromptVersion>(`/ai/prompts/${enc(id)}/accept-proposal`, { method: 'POST' }),
    onError: (err) =>
      toast({
        title: 'Proposal not accepted',
        description: errorMessage(err),
        variant: 'destructive',
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: aiKeys.prompts(taskKey) }),
  });
}

export function useDiscardProposal(taskKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(`/ai/prompts/${enc(id)}/discard-proposal`, { method: 'POST' }),
    onError: (err) =>
      toast({
        title: 'Proposal not discarded',
        description: errorMessage(err),
        variant: 'destructive',
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: aiKeys.prompts(taskKey) }),
  });
}
