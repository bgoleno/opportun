// Default model policy per task (config data). Task logic never names a model: it asks
// AiDeps.policyFor, which applies the user's override over these defaults.
import type { ModelPolicy, TaskKey } from './types';

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-5-5';

export const DEFAULT_POLICIES: Readonly<Record<TaskKey, Readonly<ModelPolicy>>> = {
  'resume.tailor': { provider: 'anthropic', model: OPUS, maxOutputTokens: 16_000 },
  'resume.match': { provider: 'anthropic', model: SONNET, maxOutputTokens: 4_000 },
  'discovery.rank': { provider: 'anthropic', model: SONNET, maxOutputTokens: 4_000 },
  'discovery.refine_prompt': { provider: 'anthropic', model: SONNET, maxOutputTokens: 4_000 },
  // Stage 2 of the mail funnel: one yes/no question about a sender, a subject and 500
  // characters, asked on every message Stage 1 positively passed. Cheapest capable model.
  'comms.triage': { provider: 'anthropic', model: HAIKU, maxOutputTokens: 500 },
  'comms.classify': { provider: 'anthropic', model: HAIKU, maxOutputTokens: 1_000 },
  'opportunity.dedupe': { provider: 'anthropic', model: HAIKU, maxOutputTokens: 1_000 },
  'referral.rationale': { provider: 'anthropic', model: SONNET, maxOutputTokens: 2_000 },
  'capture.extract': { provider: 'anthropic', model: HAIKU, maxOutputTokens: 4_000 },
  'capture.linkedin': { provider: 'anthropic', model: HAIKU, maxOutputTokens: 4_000 },
  'posting.merge': { provider: 'anthropic', model: HAIKU, maxOutputTokens: 4_000 },
  'company.suggest': { provider: 'anthropic', model: SONNET, maxOutputTokens: 4_000 },
  'integration.diagnose': { provider: 'anthropic', model: HAIKU, maxOutputTokens: 1_000 },
};

/** The user's override when present, else a copy of the task default. */
export function resolvePolicy(
  task: TaskKey,
  override: ModelPolicy | null | undefined,
): ModelPolicy {
  if (override !== null && override !== undefined) return { ...override };
  // eslint-disable-next-line security/detect-object-injection -- task is a TaskKey literal
  return { ...DEFAULT_POLICIES[task] };
}
