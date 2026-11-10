// Product features and the AI tasks that belong to each
// (https://github.com/bgoleno/opportun/issues/341). Settings > AI > Usage groups task_runs by
// feature with this map, and the observability slices (O4 traces, O6 dashboards) label by the
// same keys, so a task's feature is decided once, here. Config data only: no IO.
import { TASK_KEYS, type TaskKey } from './types';

/** In the order the Usage view lists them. A rename from the O0 design is a rename here. */
export const FEATURES = [
  { key: 'resume_tailoring', label: 'Resume tailoring' },
  { key: 'matching', label: 'Matching' },
  { key: 'discovery', label: 'Discovery' },
  { key: 'capture', label: 'Capture' },
  { key: 'mail', label: 'Mail' },
  { key: 'companies', label: 'Companies' },
  { key: 'referrals', label: 'Referrals' },
  { key: 'duplicates', label: 'Duplicates' },
  { key: 'integrations', label: 'Integrations' },
] as const;

export type FeatureKey = (typeof FEATURES)[number]['key'];

/**
 * The feature each task belongs to. Typed as a Record over every TaskKey, so a task added to
 * TASK_KEYS without a feature here fails typecheck.
 */
export const TASK_FEATURE: Record<TaskKey, FeatureKey> = {
  'resume.tailor': 'resume_tailoring',
  'resume.match': 'matching',
  'discovery.rank': 'discovery',
  'discovery.refine_prompt': 'discovery',
  'discovery.title_variants': 'discovery',
  'discovery.industry_profile': 'discovery',
  // Industry tags exist for discovery (the ranking reserve and company suggestions read them),
  // and they are charged to the discovery budget, so the task stays with its name.
  'discovery.company_tags': 'discovery',
  'comms.triage': 'mail',
  'comms.classify': 'mail',
  'opportunity.dedupe': 'duplicates',
  'referral.rationale': 'referrals',
  'capture.extract': 'capture',
  'capture.linkedin': 'capture',
  'capture.job': 'capture',
  // Merges a captured posting with the same posting from the ATS: part of saving a capture.
  'posting.merge': 'capture',
  'company.suggest': 'companies',
  'integration.diagnose': 'integrations',
};

/** A feature's tasks, in TASK_KEYS order. */
export function tasksOfFeature(feature: FeatureKey): TaskKey[] {
  return TASK_KEYS.filter((task) => TASK_FEATURE[task] === feature);
}
