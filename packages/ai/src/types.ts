// Shared contracts for the model router (FR-A1, A2, A5, A6). This package does no IO:
// keys, policies, the run ledger and spend all arrive through AiDeps.
import { z } from 'zod';

export const TASK_KEYS = [
  'resume.tailor',
  'resume.match',
  'discovery.rank',
  'discovery.refine_prompt',
  'comms.triage',
  'comms.classify',
  'opportunity.dedupe',
  'referral.rationale',
  'capture.extract',
  'capture.linkedin',
  'posting.merge',
  'company.suggest',
  'integration.diagnose',
] as const;

export type TaskKey = (typeof TASK_KEYS)[number];

export const PROVIDERS = ['anthropic', 'openai', 'openai_compatible'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export interface ModelPolicy {
  provider: ProviderId;
  model: string;
  maxOutputTokens: number;
  temperature?: number;
  /** Only used by openai_compatible; must be https or a loopback http URL. */
  baseUrl?: string;
  /** USD per million input tokens; overrides the price table (e.g. a gateway's own rate). */
  inputUsdPerMTok?: number;
  /** USD per million output tokens; overrides the price table. */
  outputUsdPerMTok?: number;
}

/** Upper bound for a per-policy price override, in USD per million tokens. */
export const MAX_PRICE_OVERRIDE_USD_PER_MTOK = 10_000;

/** Validates a stored or submitted policy (the shape of a user override). */
export const ModelPolicySchema = z.object({
  provider: z.enum(PROVIDERS),
  model: z.string().trim().min(1).max(200),
  maxOutputTokens: z.number().int().min(1).max(200_000),
  temperature: z.number().min(0).max(2).optional(),
  baseUrl: z.string().trim().max(2048).optional(),
  inputUsdPerMTok: z.number().min(0).max(MAX_PRICE_OVERRIDE_USD_PER_MTOK).optional(),
  outputUsdPerMTok: z.number().min(0).max(MAX_PRICE_OVERRIDE_USD_PER_MTOK).optional(),
}) satisfies z.ZodType<ModelPolicy>;

export interface TaskRunRecord {
  taskKey: TaskKey;
  provider: string;
  model: string;
  promptId?: string;
  inputTokens: number;
  outputTokens: number;
  /** Estimated cost in USD (stored in task_runs.est_cost). */
  estCostUsd: number;
  /** True when the model had no list price and the conservative fallback price was used. */
  fallbackPricing?: boolean;
  durationMs: number;
  status: 'ok' | 'error';
  /** A reason code, optionally followed by a sanitized detail. Never holds a key. */
  error?: string;
}

/**
 * Governs an openai_compatible policy's baseUrl (issue #334): whether plain http to
 * localhost/127.0.0.1/[::1] is permitted at all on this deployment. An operator-level decision
 * (apps/server's Config.aiAllowLoopbackHttp), never read from the environment in this package
 * directly -- this package does no IO (see this file's own header comment).
 */
export interface SafeBaseUrlOptions {
  allowLoopbackHttp: boolean;
}

/**
 * What createLanguageModel needs to build an openai_compatible client safely (issue #334): the
 * fetch to hand the SDK instead of its own default (built by apps/server's
 * lib/aiProviderFetch.ts, so this package stays IO-free), plus the loopback decision above,
 * which assertSafeBaseUrl also needs to validate the baseUrl's shape. Anthropic and OpenAI
 * never read this: their baseURL is never derived from policy.baseUrl (createLanguageModel's
 * own switch), so there is nothing user-controlled for them to validate.
 */
export interface ProviderFetchOptions extends SafeBaseUrlOptions {
  fetch: typeof fetch;
}

export interface AiDeps {
  /** The caller's API key for a provider; throws AiUnavailableError('no_key') when absent. */
  getKey(provider: string): Promise<string>;
  /** The effective policy: the user's override when set, else the task default. */
  policyFor(task: TaskKey): Promise<ModelPolicy>;
  /** Appends to the run ledger (task_runs). Called once per router call, failures included. */
  record(run: TaskRunRecord): Promise<void>;
  budget: { perTaskDailyUsd: number };
  /** Sum of today's recorded est cost for this task (the ledger lives outside this package). */
  spentTodayUsd(task: TaskKey): Promise<number>;
  /** issue #334: handed to createLanguageModel for the openai_compatible case. */
  providerFetch: ProviderFetchOptions;
}

export type AiUnavailableReason =
  'no_key' | 'budget_exceeded' | 'provider_error' | 'invalid_output';

/**
 * The single failure type the router throws. The message is safe to show and log: it never
 * contains an API key, and the underlying provider error is not attached as `cause`.
 */
export class AiUnavailableError extends Error {
  readonly reason: AiUnavailableReason;

  constructor(reason: AiUnavailableReason, detail?: string) {
    super(detail === undefined || detail === '' ? reason : `${reason}: ${detail}`);
    this.name = 'AiUnavailableError';
    this.reason = reason;
  }
}
