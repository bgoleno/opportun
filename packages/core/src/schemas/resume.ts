import { z } from 'zod';
import { IdSchema, RESUME_STATUSES, TimestampSchema } from './common';

export const RESUME_KINDS = ['base', 'tailored'] as const;
export type ResumeKind = (typeof RESUME_KINDS)[number];

export const RESUME_STORES = ['google_doc', 'local_file', 'reactive_resume'] as const;
export type ResumeStore = (typeof RESUME_STORES)[number];

export const ResumeSchema = z.object({
  id: IdSchema,
  userId: IdSchema,
  kind: z.enum(RESUME_KINDS),
  opportunityId: IdSchema.nullish(),
  title: z.string().min(1),
  store: z.enum(RESUME_STORES),
  /** Google Doc id, local file path or Reactive Resume resume id, depending on store. */
  docRef: z.string().min(1),
  parentResumeId: IdSchema.nullish(),
  status: z.enum(RESUME_STATUSES).default('draft'),
  submittedAt: TimestampSchema.nullish(),
  submittedTo: z.string().nullish(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Resume = z.infer<typeof ResumeSchema>;
