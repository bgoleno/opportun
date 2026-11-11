// Profile, role targets and resume rules (FR-P1..P4).
import {
  ApplicationDetailsPrefillSchema,
  ApplicationDetailsSchema,
  checkSeniorityRange,
  ProfileSchema,
  REMOTE_PREFS,
  RESUME_RULE_CATEGORIES,
  ResumeRuleSchema,
  RoleTargetBaseSchema,
} from '@opportun/core';
import { promptVariables, TASK_PROMPT_VARS } from '@opportun/ai';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { cleanTitleVariants, MAX_TITLE_VARIANTS, queueTitleVariants } from '../jobs/titleVariants';
import {
  createResumeRule,
  createRoleTarget,
  deleteResumeRule,
  deleteRoleTarget,
  DISCOVERY_TASK,
  editRoleTargetDiscoveryPrompt,
  getProfile,
  getRoleTargetDiscoveryPrompt,
  linkRoleTargetDiscoveryPrompt,
  getResumeRule,
  getRoleTarget,
  listResumeRules,
  listRoleTargets,
  PROFILE_TEXT_MAX,
  ProfileEmail,
  putProfile,
  RESUME_RULE_SORTS,
  ROLE_TARGET_SORTS,
  updateResumeRule,
  updateRoleTarget,
} from '../repos/profile';
import { audit } from '../lib/audit';
import { applicationDetailsFor } from '../repos/applicationDetails';
import { PromptVersionSchema } from './ai';
import { HttpUrl, IdParams, listQuery, optionalText, pageOf } from './common';

/**
 * The profile's Application details (#411) as Settings sends them: each value trimmed and an
 * empty one dropped (as optionalText clears a column), then the shared rule: only the list's
 * keys whose home is the details, each passing the draft's checks. Omitted, they stay as stored.
 */
const ApplicationDetailsBody = z
  .record(z.string(), z.string().trim())
  .transform((details) => Object.fromEntries(Object.entries(details).filter(([, v]) => v !== '')))
  .pipe(ApplicationDetailsSchema);

const ProfileBody = z.object({
  fullName: optionalText(PROFILE_TEXT_MAX.fullName),
  headline: optionalText(PROFILE_TEXT_MAX.headline),
  email: ProfileEmail.nullish(),
  phone: optionalText(PROFILE_TEXT_MAX.phone),
  location: optionalText(PROFILE_TEXT_MAX.location),
  workAuth: optionalText(PROFILE_TEXT_MAX.workAuth),
  links: z
    .array(z.object({ label: z.string().trim().min(1).max(100), url: HttpUrl }))
    .max(50)
    .optional(),
  applicationDetails: ApplicationDetailsBody.optional(),
});

/** The step's own draft, so its review does not make it "the last application" (tl, #411). */
const ApplicationDetailsQuery = z.object({ excluding: z.uuid().optional() }).strict();

const StringList = z.array(z.string().trim().min(1).max(200)).max(100);
const Level = z.number().int().nonnegative().max(100).nullish();
const Money = z.number().int().nonnegative().nullish();

const roleTargetFields = {
  name: z.string().trim().min(1).max(200),
  titleFamily: z.string().trim().min(1).max(200),
  seniorityMin: Level,
  seniorityMax: Level,
  industries: StringList,
  keywords: StringList,
  locations: StringList,
  /** The user's own list (#217); trimmed and de-duplicated as stored, at most 40. */
  titleVariants: z.array(z.string().trim().min(1).max(200)).max(MAX_TITLE_VARIANTS),
  remotePref: z.enum(REMOTE_PREFS),
  compMin: Money,
  compMax: Money,
  currency: z.string().trim().length(3).toUpperCase().nullish(),
  active: z.boolean(),
};

interface Ranges {
  seniorityMin?: number | null | undefined;
  seniorityMax?: number | null | undefined;
  compMin?: number | null | undefined;
  compMax?: number | null | undefined;
}

function checkRanges(value: Ranges, ctx: z.RefinementCtx): void {
  checkSeniorityRange(value, ctx);
  const { compMin, compMax } = value;
  if (compMin != null && compMax != null && compMin > compMax) {
    ctx.addIssue({ code: 'custom', path: ['compMin'], message: 'compMin must not exceed compMax' });
  }
}

const RoleTargetCreate = z
  .object({
    ...roleTargetFields,
    industries: StringList.default([]),
    keywords: StringList.default([]),
    locations: StringList.default([]),
    titleVariants: z.array(z.string().trim().min(1).max(200)).max(MAX_TITLE_VARIANTS).default([]),
    remotePref: z.enum(REMOTE_PREFS).default('any'),
    active: z.boolean().default(true),
  })
  .superRefine(checkRanges);
const RoleTargetPatch = z.object(roleTargetFields).partial().superRefine(checkRanges);
/** Re-checks the ranges after a patch is merged over the stored row. */
const MergedRanges = z
  .object({ seniorityMin: Level, seniorityMax: Level, compMin: Money, compMax: Money })
  .superRefine(checkRanges);

/** A role target's discovery prompt may only use the discovery.rank variables. */
const DiscoveryPromptBody = z.object({
  body: z
    .string()
    .trim()
    .min(1)
    .max(50_000)
    .superRefine((body, ctx) => {
      const allowed = new Set(TASK_PROMPT_VARS['discovery.rank']);
      const unknown = promptVariables(body).filter((name) => !allowed.has(name));
      if (unknown.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message: `Unknown placeholder(s): ${unknown.map((n) => `{{${n}}}`).join(', ')}. Available: ${[...allowed].map((n) => `{{${n}}}`).join(', ')}`,
        });
      }
    }),
});
const DiscoveryPromptLink = z.object({ promptId: z.string().min(1).max(64).nullable() });
const RoleTargetDiscoveryPromptSchema = z.object({
  roleTargetId: z.string(),
  prompt: PromptVersionSchema,
  linked: z.boolean(),
  proposal: PromptVersionSchema.nullable(),
});

const resumeRuleFields = {
  ruleText: z.string().trim().min(1).max(2000),
  category: z.enum(RESUME_RULE_CATEGORIES),
  active: z.boolean(),
  sortOrder: z.number().int().min(-1_000_000).max(1_000_000),
};
const ResumeRuleCreate = z.object({
  ...resumeRuleFields,
  active: z.boolean().default(true),
  sortOrder: resumeRuleFields.sortOrder.default(0),
});
const ResumeRulePatch = z.object(resumeRuleFields).partial();

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  // --- profile -------------------------------------------------------------

  api.get('/profile', { schema: { response: { 200: ProfileSchema } } }, async (req) =>
    getProfile(db, app.requireUser(req)),
  );

  api.put(
    '/profile',
    { schema: { body: ProfileBody, response: { 200: ProfileSchema } } },
    async (req) => putProfile(db, app.requireUser(req), req.body),
  );

  // What a new application draft is filled with, each value with its source (#411), for the
  // details step to say where each came from. Session only, like every /profile route: the
  // extension's device token never reaches it (it receives only the reviewed attempt).
  api.get(
    '/profile/application-details',
    {
      schema: {
        querystring: ApplicationDetailsQuery,
        response: { 200: ApplicationDetailsPrefillSchema },
      },
    },
    async (req) =>
      applicationDetailsFor(db, app.requireUser(req), { excluding: req.query.excluding ?? null }),
  );

  // --- role targets --------------------------------------------------------

  api.get(
    '/role-targets',
    {
      schema: {
        querystring: listQuery([...ROLE_TARGET_SORTS.keys()]),
        response: { 200: pageOf(RoleTargetBaseSchema) },
      },
    },
    async (req) => listRoleTargets(db, app.requireUser(req), req.query),
  );

  api.post(
    '/role-targets',
    { schema: { body: RoleTargetCreate, response: { 201: RoleTargetBaseSchema } } },
    async (req, reply) => {
      const ctx = app.requireUser(req);
      const titleVariants = cleanTitleVariants(req.body.titleVariants);
      // Its title variants come from one AI call (#217), unless the user wrote their own.
      const needed = titleVariants.length === 0;
      const created = await createRoleTarget(db, ctx, {
        ...req.body,
        titleVariants,
        titleVariantsNeeded: needed,
      });
      if (needed) await queueTitleVariants(db, ctx, created);
      return reply.code(201).send(created);
    },
  );

  api.get(
    '/role-targets/:id',
    { schema: { params: IdParams, response: { 200: RoleTargetBaseSchema } } },
    async (req) => getRoleTarget(db, app.requireUser(req), req.params.id),
  );

  api.patch(
    '/role-targets/:id',
    {
      schema: { params: IdParams, body: RoleTargetPatch, response: { 200: RoleTargetBaseSchema } },
    },
    async (req) => {
      const ctx = app.requireUser(req);
      const current = await getRoleTarget(db, ctx, req.params.id);
      MergedRanges.parse({ ...current, ...req.body });
      const { titleVariants, ...rest } = req.body;
      // A new name or title family means new variants (#217), unless this edit wrote them. A list
      // the user saves, an empty one included, is theirs: no call under way may overwrite it.
      const renamed =
        (rest.name !== undefined && rest.name !== current.name) ||
        (rest.titleFamily !== undefined && rest.titleFamily !== current.titleFamily);
      const updated = await updateRoleTarget(db, ctx, req.params.id, {
        ...rest,
        ...(titleVariants !== undefined
          ? { titleVariants: cleanTitleVariants(titleVariants), titleVariantsNeeded: false }
          : renamed
            ? { titleVariantsNeeded: true }
            : {}),
      });
      if (renamed && titleVariants === undefined) await queueTitleVariants(db, ctx, updated);
      return updated;
    },
  );

  api.delete(
    '/role-targets/:id',
    { schema: { params: IdParams, response: { 204: z.null() } } },
    async (req, reply) => {
      await deleteRoleTarget(db, app.requireUser(req), req.params.id);
      return reply.code(204).send(null);
    },
  );

  // Per-role-target discovery prompt (FR-P3): read, edit (new linked version), link or reset.
  api.get(
    '/role-targets/:id/discovery-prompt',
    { schema: { params: IdParams, response: { 200: RoleTargetDiscoveryPromptSchema } } },
    async (req) => await getRoleTargetDiscoveryPrompt(db, app.requireUser(req), req.params.id),
  );

  api.post(
    '/role-targets/:id/discovery-prompt',
    {
      schema: {
        params: IdParams,
        body: DiscoveryPromptBody,
        response: { 201: RoleTargetDiscoveryPromptSchema },
      },
    },
    async (req, reply) => {
      const ctx = app.requireUser(req);
      const view = await editRoleTargetDiscoveryPrompt(db, ctx, req.params.id, req.body.body);
      await audit(db, 'ai.prompt.created', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { id: view.prompt.id, taskKey: DISCOVERY_TASK, roleTargetId: req.params.id },
      });
      return reply.code(201).send(view);
    },
  );

  api.put(
    '/role-targets/:id/discovery-prompt',
    {
      schema: {
        params: IdParams,
        body: DiscoveryPromptLink,
        response: { 200: RoleTargetDiscoveryPromptSchema },
      },
    },
    async (req) => {
      const ctx = app.requireUser(req);
      const view = await linkRoleTargetDiscoveryPrompt(db, ctx, req.params.id, req.body.promptId);
      await audit(db, 'ai.prompt.linked', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { roleTargetId: req.params.id, id: req.body.promptId },
      });
      return view;
    },
  );

  // --- resume rules --------------------------------------------------------

  api.get(
    '/resume-rules',
    {
      schema: {
        querystring: listQuery([...RESUME_RULE_SORTS.keys()]),
        response: { 200: pageOf(ResumeRuleSchema) },
      },
    },
    async (req) => listResumeRules(db, app.requireUser(req), req.query),
  );

  api.post(
    '/resume-rules',
    { schema: { body: ResumeRuleCreate, response: { 201: ResumeRuleSchema } } },
    async (req, reply) =>
      reply.code(201).send(await createResumeRule(db, app.requireUser(req), req.body)),
  );

  api.get(
    '/resume-rules/:id',
    { schema: { params: IdParams, response: { 200: ResumeRuleSchema } } },
    async (req) => getResumeRule(db, app.requireUser(req), req.params.id),
  );

  api.patch(
    '/resume-rules/:id',
    { schema: { params: IdParams, body: ResumeRulePatch, response: { 200: ResumeRuleSchema } } },
    async (req) => updateResumeRule(db, app.requireUser(req), req.params.id, req.body),
  );

  api.delete(
    '/resume-rules/:id',
    { schema: { params: IdParams, response: { 204: z.null() } } },
    async (req, reply) => {
      await deleteResumeRule(db, app.requireUser(req), req.params.id);
      return reply.code(204).send(null);
    },
  );
}
