import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';

export const ProfileLinkSchema = z.object({
  label: z.string().min(1),
  url: z.url(),
});
export type ProfileLink = z.infer<typeof ProfileLinkSchema>;

/** One profile per user (design 4.2). */
export const ProfileSchema = z.object({
  userId: IdSchema,
  fullName: z.string().nullish(),
  headline: z.string().nullish(),
  email: z.email().nullish(),
  phone: z.string().nullish(),
  location: z.string().nullish(),
  workAuth: z.string().nullish(),
  links: z.array(ProfileLinkSchema).default([]),
  updatedAt: TimestampSchema,
});
export type Profile = z.infer<typeof ProfileSchema>;

export const REMOTE_PREFS = ['remote', 'hybrid', 'onsite', 'any'] as const;
export type RemotePref = (typeof REMOTE_PREFS)[number];

/**
 * Role target fields without cross-field checks. zod refuses .omit/.partial on refined
 * objects, so derive create/patch shapes from this and re-apply checkSeniorityRange.
 * Seniority is an ordinal integer level (higher is more senior).
 */
export const RoleTargetBaseSchema = z.object({
  id: IdSchema,
  userId: IdSchema,
  name: z.string().min(1),
  titleFamily: z.string().min(1),
  seniorityMin: z.number().int().nonnegative().nullish(),
  seniorityMax: z.number().int().nonnegative().nullish(),
  industries: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  locations: z.array(z.string()).default([]),
  remotePref: z.enum(REMOTE_PREFS).default('any'),
  compMin: z.number().int().nonnegative().nullish(),
  compMax: z.number().int().nonnegative().nullish(),
  currency: z.string().length(3).nullish(),
  active: z.boolean().default(true),
  discoveryPromptId: IdSchema.nullish(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export function checkSeniorityRange(
  value: { seniorityMin?: number | null; seniorityMax?: number | null },
  ctx: z.RefinementCtx,
): void {
  const { seniorityMin, seniorityMax } = value;
  if (seniorityMin != null && seniorityMax != null && seniorityMin > seniorityMax) {
    ctx.addIssue({
      code: 'custom',
      path: ['seniorityMin'],
      message: 'seniorityMin must not exceed seniorityMax',
    });
  }
}

export const RoleTargetSchema = RoleTargetBaseSchema.superRefine(checkSeniorityRange);
export type RoleTarget = z.infer<typeof RoleTargetSchema>;

export const RESUME_RULE_CATEGORIES = ['style', 'content', 'redaction'] as const;
export type ResumeRuleCategory = (typeof RESUME_RULE_CATEGORIES)[number];

export const ResumeRuleSchema = z.object({
  id: IdSchema,
  userId: IdSchema,
  ruleText: z.string().min(1),
  category: z.enum(RESUME_RULE_CATEGORIES),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ResumeRule = z.infer<typeof ResumeRuleSchema>;
