// Secrets vault API (FR-A3). Responses carry metadata only: the value goes in once and
// never comes back out over HTTP (NFR-SEC4).
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { SECRET_KINDS } from '../db/schema';
import { enqueueClassifyBackfill } from '../jobs/classifyBackfill';
import { audit } from '../lib/audit';
import {
  deleteKeyValidation,
  KeyValidationSchema,
  validateAndStoreAiKey,
} from '../lib/aiKeyValidate';
import {
  deleteSecret,
  getSecretMeta,
  listSecrets,
  putSecret,
  updateSecretMeta,
} from '../lib/secretBox';
import { requireUser } from '../repos/base';

const SecretMetaSchema = z.object({
  id: z.string(),
  kind: z.enum(SECRET_KINDS),
  label: z.string(),
  displayName: z.string().nullable(),
  expiresAt: z.number().int().nullable(),
  createdAt: z.number().int(),
});
/** Epoch ms between 2000 and 2200: a user-entered expiry date. */
const ExpiresAt = z.number().int().min(946_684_800_000).max(7_258_118_400_000);
const DisplayName = z.string().trim().max(100);
const CreateBody = z.object({
  kind: z.enum(SECRET_KINDS),
  label: z.string().trim().min(1).max(100),
  value: z.string().min(1).max(16_384),
  displayName: DisplayName.optional(),
  expiresAt: ExpiresAt.nullable().optional(),
});
/** Only the user-editable metadata: the value, kind and label cannot change here. */
const PatchBody = z
  .object({
    displayName: DisplayName.nullable().optional(),
    expiresAt: ExpiresAt.nullable().optional(),
  })
  .strict();
/** An ai_api_key create also returns the inline validation of the new key. */
const CreatedSchema = SecretMetaSchema.extend({ validation: KeyValidationSchema.optional() });

const emptyToNull = (v: string | null | undefined): string | null | undefined =>
  v === undefined ? undefined : v === null || v === '' ? null : v;
const IdParams = z.object({ id: z.string().min(1).max(64) });

export async function secretRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  api.get(
    '/secrets',
    {
      schema: {
        response: { 200: z.object({ items: z.array(SecretMetaSchema), total: z.number().int() }) },
      },
    },
    async (req) => {
      const items = await listSecrets(db, requireUser(req));
      return { items, total: items.length };
    },
  );

  api.post(
    '/secrets',
    { schema: { body: CreateBody, response: { 201: CreatedSchema } } },
    async (req, reply) => {
      const ctx = requireUser(req);
      const { kind, label, value } = req.body;
      const displayName = emptyToNull(req.body.displayName);
      const { id } = await putSecret(db, ctx, kind, label, value, {
        ...(displayName === undefined ? {} : { displayName }),
        ...(req.body.expiresAt === undefined ? {} : { expiresAt: req.body.expiresAt }),
      });
      const meta = await getSecretMeta(db, ctx, id);
      await audit(db, 'secret.created', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { id, kind, label },
      });
      // Messages synced before the user had an AI key were never classified.
      if (kind !== 'ai_api_key') return reply.code(201).send(meta);
      await enqueueClassifyBackfill(db, ctx);
      // Validate on add. The key is stored either way; a failure (or a provider outage) shows
      // up as ok=false with a sanitized reason, never as a failed create.
      const validation = await validateAndStoreAiKey(db, ctx, id).catch(() => ({
        ok: false,
        provider: label,
        models: [],
        expiresAt: null,
        checkedAt: Date.now(),
        error: 'validation failed',
      }));
      return reply.code(201).send({ ...meta, validation });
    },
  );

  api.patch(
    '/secrets/:id',
    { schema: { params: IdParams, body: PatchBody, response: { 200: SecretMetaSchema } } },
    async (req) => {
      const ctx = requireUser(req);
      const displayName = emptyToNull(req.body.displayName);
      const updated = await updateSecretMeta(db, ctx, req.params.id, {
        ...(displayName === undefined ? {} : { displayName }),
        ...(req.body.expiresAt === undefined ? {} : { expiresAt: req.body.expiresAt }),
      });
      await audit(db, 'secret.updated', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { id: updated.id, kind: updated.kind, label: updated.label },
      });
      return updated;
    },
  );

  api.delete(
    '/secrets/:id',
    { schema: { params: IdParams, response: { 204: z.null() } } },
    async (req, reply) => {
      const ctx = requireUser(req);
      const removed = await deleteSecret(db, ctx, req.params.id);
      await deleteKeyValidation(db, ctx, removed.id);
      await audit(db, 'secret.deleted', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { id: removed.id, kind: removed.kind, label: removed.label },
      });
      return reply.code(204).send(null);
    },
  );
}
