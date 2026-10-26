import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';

/** Versioned prompt. userId is null for seeded system defaults (design 4.5). */
export const PromptSchema = z.object({
  id: IdSchema,
  userId: IdSchema.nullable(),
  taskKey: z.string().min(1),
  name: z.string().min(1),
  body: z.string().min(1),
  version: z.number().int().min(1),
  parentId: IdSchema.nullish(),
  isActive: z.boolean(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Prompt = z.infer<typeof PromptSchema>;
