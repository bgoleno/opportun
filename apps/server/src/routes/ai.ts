// AI settings API (FR-A2, A4, A5): versioned prompts, per-task model policy overrides, and the
// usage rollup. Everything is scoped to the signed-in user; no route here returns a key.
import {
  DEFAULT_POLICIES,
  isSafeBaseUrl,
  ModelPolicySchema,
  PROVIDERS,
  promptVariables,
  TASK_KEYS,
  TASK_PROMPT_VARS,
  TASKS,
} from '@opportun/ai';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  deletePolicyOverride,
  readBudget,
  readPolicyOverride,
  writePolicyOverride,
} from '../lib/ai';
import {
  KeyValidationSchema,
  readKeyValidation,
  validateAndStoreAiKey,
} from '../lib/aiKeyValidate';
import { audit } from '../lib/audit';
import { listSecrets } from '../lib/secretBox';
import { HttpError } from '../lib/errors';
import { requireUser } from '../repos/base';
import {
  acceptProposal,
  activatePrompt,
  createPromptVersion,
  discardProposal,
  getPromptVersion,
  listPromptVersions,
} from '../repos/prompts';
import { usageRollup } from '../repos/taskRuns';
import { IdParams } from './common';

const TaskKeySchema = z.enum(TASK_KEYS);

export const PromptVersionSchema = z.object({
  id: z.string(),
  taskKey: z.string(),
  name: z.string(),
  body: z.string(),
  version: z.number().int(),
  parentId: z.string().nullable(),
  isActive: z.boolean(),
  isSystem: z.boolean(),
  proposed: z.boolean(),
  proposalSummary: z.string().nullable(),
  createdAt: z.number().int(),
});

/** An edit may only use the variables its task supplies; anything else fails at render time. */
const CreatePromptBody = z
  .object({
    taskKey: TaskKeySchema,
    body: z.string().trim().min(1).max(50_000),
  })
  .superRefine((v, ctx) => {
    const allowed = new Set(TASK_PROMPT_VARS[v.taskKey]);
    const unknown = promptVariables(v.body).filter((name) => !allowed.has(name));
    if (unknown.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['body'],
        message: `Unknown placeholder(s): ${unknown.map((n) => `{{${n}}}`).join(', ')}. Available: ${[...allowed].map((n) => `{{${n}}}`).join(', ')}`,
      });
    }
  });

const UsageQuery = z.object({ days: z.coerce.number().int().min(1).max(366).default(30) });
const UsageMetrics = {
  taskKey: z.string(),
  runs: z.number().int(),
  errors: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  estCostUsd: z.number(),
  estimated: z.boolean(),
};
const UsageSchema = z.object({
  days: z.number().int(),
  items: z.array(z.object({ day: z.string(), ...UsageMetrics })),
  totals: z.array(z.object(UsageMetrics)),
});

const PolicyOut = z.object({
  provider: z.enum(PROVIDERS),
  model: z.string(),
  maxOutputTokens: z.number().int(),
  temperature: z.number().optional(),
  baseUrl: z.string().optional(),
  inputUsdPerMTok: z.number().optional(),
  outputUsdPerMTok: z.number().optional(),
});
const TaskPolicySchema = z.object({
  taskKey: TaskKeySchema,
  description: z.string(),
  defaultPolicy: PolicyOut,
  override: PolicyOut.nullable(),
});
const TaskParams = z.object({ taskKey: TaskKeySchema });
const SecretIdParams = z.object({ secretId: z.string().min(1).max(64) });
/** A provider key as the AI settings page shows it: metadata plus the last validation. */
const AiKeySchema = z.object({
  id: z.string(),
  label: z.string(),
  displayName: z.string().nullable(),
  expiresAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  validation: KeyValidationSchema.nullable(),
});

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  // Built per app-boot (issue #334), not at module scope: the operator's loopback-http
  // decision (Config.aiAllowLoopbackHttp) is only reachable here, through app.config, which a
  // module-level const cannot see. Real enforcement is lib/aiProviderFetch.ts at actual-fetch
  // time regardless of what this schema accepts; this is an early, friendly rejection at
  // policy-submit time, using the exact same flag so the two never disagree.
  const allowLoopbackHttp = app.config.aiAllowLoopbackHttp;
  /** A submitted override: an openai_compatible policy needs a safe baseUrl. */
  const PolicyBody = ModelPolicySchema.superRefine((p, ctx) => {
    if (p.provider === 'openai_compatible' && !isSafeBaseUrl(p.baseUrl, { allowLoopbackHttp })) {
      ctx.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: allowLoopbackHttp
          ? 'baseUrl must be https, or http on localhost'
          : 'baseUrl must be https (http on localhost is disabled on this deployment)',
      });
    }
  });

  // ---- prompts -------------------------------------------------------------

  api.get(
    '/ai/prompts',
    {
      schema: {
        querystring: z.object({ taskKey: TaskKeySchema.optional() }),
        response: { 200: z.object({ items: z.array(PromptVersionSchema) }) },
      },
    },
    async (req) => ({
      items: await listPromptVersions(db, requireUser(req), req.query.taskKey),
    }),
  );

  api.post(
    '/ai/prompts',
    { schema: { body: CreatePromptBody, response: { 201: PromptVersionSchema } } },
    async (req, reply) => {
      const ctx = requireUser(req);
      const created = await createPromptVersion(db, ctx, req.body.taskKey, req.body.body);
      await audit(db, 'ai.prompt.created', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { id: created.id, taskKey: created.taskKey, version: created.version },
      });
      return reply.code(201).send(created);
    },
  );

  api.post(
    '/ai/prompts/:id/activate',
    { schema: { params: IdParams, response: { 200: PromptVersionSchema } } },
    async (req) => {
      const ctx = requireUser(req);
      // A proposal is accepted through accept-proposal, which links a role target's proposal
      // to that role target; activating it here would apply it globally and orphan the link.
      if ((await getPromptVersion(db, ctx, req.params.id))?.proposed === true) {
        throw new HttpError(
          409,
          'proposal_use_accept',
          'Accept or discard the proposed refinement instead of activating it.',
        );
      }
      const activated = await activatePrompt(db, ctx, req.params.id);
      await audit(db, 'ai.prompt.activated', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { id: activated.id, taskKey: activated.taskKey, system: activated.isSystem },
      });
      return activated;
    },
  );

  // Proposed refinements: created only by the weekly job, inactive until accepted here.
  api.post(
    '/ai/prompts/:id/accept-proposal',
    { schema: { params: IdParams, response: { 200: PromptVersionSchema } } },
    async (req) => {
      const ctx = requireUser(req);
      const accepted = await acceptProposal(db, ctx, req.params.id);
      await audit(db, 'ai.prompt.proposal_accepted', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { id: accepted.id, taskKey: accepted.taskKey, version: accepted.version },
      });
      return accepted;
    },
  );

  api.post(
    '/ai/prompts/:id/discard-proposal',
    { schema: { params: IdParams, response: { 204: z.null() } } },
    async (req, reply) => {
      const ctx = requireUser(req);
      await discardProposal(db, ctx, req.params.id);
      await audit(db, 'ai.prompt.proposal_discarded', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { id: req.params.id },
      });
      return reply.code(204).send(null);
    },
  );

  // ---- model policies --------------------------------------------------------

  api.get(
    '/ai/policies',
    {
      schema: {
        response: {
          200: z.object({
            items: z.array(TaskPolicySchema),
            budget: z.object({ perTaskDailyUsd: z.number() }),
          }),
        },
      },
    },
    async (req) => {
      const ctx = requireUser(req);
      const items = [];
      for (const taskKey of TASK_KEYS) {
        items.push({
          taskKey,
          // eslint-disable-next-line security/detect-object-injection -- taskKey is a TaskKey
          description: TASKS[taskKey].description,
          // eslint-disable-next-line security/detect-object-injection -- taskKey is a TaskKey
          defaultPolicy: { ...DEFAULT_POLICIES[taskKey] },
          override: await readPolicyOverride(db, ctx, taskKey),
        });
      }
      return { items, budget: await readBudget(db, ctx) };
    },
  );

  api.put(
    '/ai/policies/:taskKey',
    { schema: { params: TaskParams, body: PolicyBody, response: { 200: TaskPolicySchema } } },
    async (req) => {
      const ctx = requireUser(req);
      const { taskKey } = req.params;
      const policy = req.body;
      // baseUrl only means something for openai_compatible; never store it for other providers.
      const stored =
        policy.provider === 'openai_compatible' ? policy : { ...policy, baseUrl: undefined };
      if (stored.baseUrl === undefined) delete stored.baseUrl;
      await writePolicyOverride(db, ctx, taskKey, stored);
      await audit(db, 'ai.policy.updated', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { taskKey, provider: stored.provider, model: stored.model },
      });
      return {
        taskKey,
        // eslint-disable-next-line security/detect-object-injection -- taskKey is a TaskKey
        description: TASKS[taskKey].description,
        // eslint-disable-next-line security/detect-object-injection -- taskKey is a TaskKey
        defaultPolicy: { ...DEFAULT_POLICIES[taskKey] },
        override: await readPolicyOverride(db, ctx, taskKey),
      };
    },
  );

  api.delete(
    '/ai/policies/:taskKey',
    { schema: { params: TaskParams, response: { 204: z.null() } } },
    async (req, reply) => {
      const ctx = requireUser(req);
      await deletePolicyOverride(db, ctx, req.params.taskKey);
      return reply.code(204).send(null);
    },
  );

  // ---- provider keys ---------------------------------------------------------------

  api.get(
    '/ai/keys',
    { schema: { response: { 200: z.object({ items: z.array(AiKeySchema) }) } } },
    async (req) => {
      const ctx = requireUser(req);
      const items = [];
      for (const s of (await listSecrets(db, ctx)).filter((x) => x.kind === 'ai_api_key')) {
        items.push({
          id: s.id,
          label: s.label,
          displayName: s.displayName,
          expiresAt: s.expiresAt,
          createdAt: s.createdAt,
          validation: await readKeyValidation(db, ctx, s.id),
        });
      }
      return { items };
    },
  );

  // Not a task: no budget check and no task_runs row. 404 for anything but the caller's key.
  api.post(
    '/ai/keys/:secretId/validate',
    { schema: { params: SecretIdParams, response: { 200: KeyValidationSchema } } },
    async (req) => {
      const ctx = requireUser(req);
      const result = await validateAndStoreAiKey(db, ctx, req.params.secretId);
      await audit(db, 'ai.key.validated', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { id: req.params.secretId, provider: result.provider, ok: result.ok },
      });
      return result;
    },
  );

  // ---- usage -------------------------------------------------------------------

  api.get(
    '/ai/usage',
    { schema: { querystring: UsageQuery, response: { 200: UsageSchema } } },
    async (req) => await usageRollup(db, requireUser(req), req.query.days),
  );
}
