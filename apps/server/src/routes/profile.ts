// Profile, role targets and resume rules (FR-P1..P4).
import {
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
  putProfile,
  RESUME_RULE_SORTS,
  ROLE_TARGET_SORTS,
  updateResumeRule,
  updateRoleTarget,
} from '../repos/profile';
import { audit } from '../lib/audit';
import { PromptVersionSchema } from './ai';
import { HttpUrl, IdParams, listQuery, optionalText, pageOf } from './common';

const ProfileBody = z.object({
  fullName: optionalText(200),
  headline: optionalText(300),
  email: z.email().max(254).nullish(),
  phone: optionalText(50),
  location: optionalText(200),
  workAuth: optionalText(200),
  links: z
    .array(z.object({ label: z.string().trim().min(1).max(100), url: HttpUrl }))
    .max(50)
    .optional(),
});

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
    async (req, reply) =>
      reply.code(201).send(await createRoleTarget(db, app.requireUser(req), req.body)),
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
      return updateRoleTarget(db, ctx, req.params.id, req.body);
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
