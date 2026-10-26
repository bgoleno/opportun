import { z } from 'zod';
import { TimestampSchema } from './common';

/**
 * The first-run tour's steps (FR-U11), by id rather than index so a later reorder cannot
 * corrupt saved progress. Order here is the tour's order.
 */
export const TOUR_STEP_IDS = [
  'welcome',
  'checklist',
  'ai-key',
  'mail',
  'inbox',
  'first-opportunity',
  'discovery',
  'resumes',
  'contacts',
  'finish',
] as const;
export type TourStepId = (typeof TOUR_STEP_IDS)[number];

export const TOUR_STATUSES = [
  'not_started',
  'in_progress',
  'paused',
  'completed',
  'skipped',
] as const;
export type TourStatus = (typeof TOUR_STATUSES)[number];

/** The tour definition the stored state refers to; a later tour can re-offer itself. */
export const TOUR_VERSION = 1;

export const TourStateSchema = z.object({
  version: z.number().int().min(1),
  status: z.enum(TOUR_STATUSES),
  stepId: z.enum(TOUR_STEP_IDS).nullable(),
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
});
export type TourState = z.infer<typeof TourStateSchema>;

/** The setup checklist (FR-U12): the three activation items, computed by the server. */
export const ChecklistSchema = z.object({
  aiKey: z.boolean(),
  mail: z.boolean(),
  firstOpportunity: z.boolean(),
  dismissed: z.boolean(),
  activatedAt: TimestampSchema.nullable(),
});
export type Checklist = z.infer<typeof ChecklistSchema>;

export const OnboardingSchema = z.object({
  tour: TourStateSchema,
  checklist: ChecklistSchema,
  autoStart: z.boolean(),
  /** The public demo instance (OPPORTUN_DEMO=1): a view-only tour, no checklist. */
  demo: z.boolean(),
});
export type Onboarding = z.infer<typeof OnboardingSchema>;
