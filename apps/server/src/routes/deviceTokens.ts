// Device token management (FR-M5, FR-C5), session-authenticated: create (the token is in this
// one response only), list (metadata only) and revoke. The tokens themselves are accepted only
// by connector routes that opt in with deviceRoute (lib/deviceTokens).
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { DEVICE_TOKEN_SCOPES } from '../db/schema';
import { audit } from '../lib/audit';
import {
  createDeviceToken,
  listDeviceTokens,
  renameDeviceToken,
  revokeDeviceToken,
} from '../lib/deviceTokens';
import { confirmPassword, reauthLimits } from '../lib/reauth';
import { requireUser } from '../repos/base';

const Meta = z.object({
  id: z.string(),
  name: z.string(),
  scopes: z.array(z.enum(DEVICE_TOKEN_SCOPES)),
  lastUsedAt: z.number().int().nullable(),
  revokedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
});
const CreateBody = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z
    .array(z.enum(DEVICE_TOKEN_SCOPES))
    .min(1)
    .max(DEVICE_TOKEN_SCOPES.length * 2),
  /** The current password: minting a credential needs more than the session cookie. */
  password: z.string().min(1).max(1024),
});
const ErrorResponse = z.object({ error: z.object({ code: z.string() }) });
const IdParams = z.object({ id: z.string().min(1).max(64) });
/** A label only: renaming grants nothing, so it needs no password (design D6). */
const RenameBody = z.object({ name: z.string().trim().min(1).max(100) });

export async function deviceTokenRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  api.get(
    '/device-tokens',
    { schema: { response: { 200: z.object({ items: z.array(Meta) }) } } },
    async (req) => ({ items: await listDeviceTokens(db, requireUser(req)) }),
  );

  api.post(
    '/device-tokens',
    {
      preHandler: reauthLimits(db),
      schema: {
        body: CreateBody,
        response: {
          201: Meta.extend({ token: z.string() }),
          403: ErrorResponse,
          429: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const ctx = requireUser(req);
      const confirmed = await confirmPassword(req, reply, {
        userId: ctx.userId,
        password: req.body.password,
        action: 'device_token.create',
      });
      if (!confirmed) return reply;
      const { name, scopes } = req.body;
      const { meta, token } = await createDeviceToken(db, ctx, { name, scopes });
      await audit(db, 'device_token.created', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { id: meta.id, name: meta.name, scopes: meta.scopes },
      });
      // The only time the token leaves the server; it is stored as a SHA-256 hash.
      return reply.code(201).send({ ...meta, token });
    },
  );

  api.patch(
    '/device-tokens/:id',
    { schema: { params: IdParams, body: RenameBody, response: { 200: Meta } } },
    async (req) => {
      const ctx = requireUser(req);
      const before = (await listDeviceTokens(db, ctx)).find((t) => t.id === req.params.id);
      const renamed = await renameDeviceToken(db, ctx, req.params.id, req.body.name);
      // Renaming is how a token someone wants to keep is made to look unremarkable in the
      // list, so it belongs in the log beside creation and revocation.
      await audit(db, 'device_token.renamed', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { id: renamed.id, from: before?.name, to: renamed.name },
      });
      return renamed;
    },
  );

  api.delete(
    '/device-tokens/:id',
    { schema: { params: IdParams, response: { 204: z.null() } } },
    async (req, reply) => {
      const ctx = requireUser(req);
      const before = (await listDeviceTokens(db, ctx)).find((t) => t.id === req.params.id);
      const revoked = await revokeDeviceToken(db, ctx, req.params.id);
      if (before?.revokedAt === null) {
        await audit(db, 'device_token.revoked', {
          userId: ctx.userId,
          ip: req.ip,
          detail: { id: revoked.id, name: revoked.name },
        });
      }
      return reply.code(204).send(null);
    },
  );
}
