// Device token management (FR-M5, FR-C5), session-authenticated: create (the token is in this
// one response only), list (metadata only) and revoke. The tokens themselves are accepted only
// by connector routes that opt in with deviceRoute (lib/deviceTokens).
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { DEVICE_TOKEN_SCOPES } from '../db/schema';
import { demoTokenCap, submissionsEnabled } from '../config';
import { isSharedDemoAccount } from '../lib/demoAccounts';
import { sharedAssistedApplyOff } from '../lib/demoOwnData';
import { demoActorOf } from '../plugins/session';
import { withTransaction } from '../db/client';
import { audit } from '../lib/audit';
import { HttpError } from '../lib/errors';
import {
  createDeviceToken,
  listDeviceTokens,
  renameDeviceToken,
  revokeDeviceToken,
} from '../lib/deviceTokens';
import { racePoint } from '../lib/racePoints';
import { confirmedPasswordHash, reauthLimits } from '../lib/reauth';
import { requireUser } from '../repos/base';
import { ErrorResponse } from './common';

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
      // The assisted apply scope exists only where the feature is on (#182; sec): its routes
      // 404 otherwise, and no token should carry a right this server never grants.
      if (
        req.body.scopes.includes('apply:assist') &&
        (!submissionsEnabled(app.config) || sharedAssistedApplyOff(app.config, ctx.userId))
      ) {
        throw new HttpError(
          422,
          'scope_unavailable',
          'Assisted apply is not available here.',
          undefined,
          { userFacing: true },
        );
      }
      const verified = await confirmedPasswordHash(req, reply, {
        userId: ctx.userId,
        password: req.body.password,
        action: 'device_token.create',
      });
      if (verified === null) return reply;
      // Between the check and the insert a password change that revokes tokens, or a reset, can
      // commit: the insert is made only while the verified hash is still current (#539).
      await racePoint('deviceTokens.create.passwordChecked');
      const { name, scopes } = req.body;
      // The insert is made only while the verified password hash is still current (#539). On a
      // shared demo account (decision 133), also: at most OPPORTUN_DEMO_TOKEN_CAP active tokens,
      // the oldest revoked to make room (sec on #544, tl on #550; 0 means no cap), and the token
      // records its visitor, so it is given only their attempts (#545). All of it is one call and
      // one transaction (tl). An account made for one person on a demo server has neither.
      const sharedAccount = isSharedDemoAccount(app.config, ctx.userId);
      const cap = demoTokenCap(app.config);
      const { meta, token } = await createDeviceToken(
        db,
        ctx,
        { name, scopes },
        {
          passwordHash: verified,
          ...(sharedAccount
            ? { ...(cap > 0 ? { maxActive: cap } : {}), ip: req.ip, actor: demoActorOf(req) }
            : {}),
          // With the token, in its transaction (#802): a failed write creates nothing.
          onCreated: async (tx, created) => {
            await audit(tx, 'device_token.created', {
              userId: ctx.userId,
              ip: req.ip,
              detail: { id: created.id, name: created.name, scopes: created.scopes },
            });
          },
        },
      );
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
      // Renaming is how a token someone wants to keep is made to look unremarkable in the
      // list, so it belongs in the log beside creation and revocation: in one transaction (#802).
      return await withTransaction(db, async (tx) => {
        const renamed = await renameDeviceToken(tx, ctx, req.params.id, req.body.name);
        await audit(tx, 'device_token.renamed', {
          userId: ctx.userId,
          ip: req.ip,
          detail: { id: renamed.id, from: before?.name, to: renamed.name },
        });
        return renamed;
      });
    },
  );

  api.delete(
    '/device-tokens/:id',
    { schema: { params: IdParams, response: { 204: z.null() } } },
    async (req, reply) => {
      const ctx = requireUser(req);
      // Recorded by the call that revoked it, after the revocation has committed (#802, sec): a
      // second revoke of a revoked token records nothing, and a failed write leaves it revoked.
      await revokeDeviceToken(db, ctx, req.params.id, async (revoked) => {
        await audit(db, 'device_token.revoked', {
          userId: ctx.userId,
          ip: req.ip,
          detail: { id: revoked.id, name: revoked.name },
        });
      });
      return reply.code(204).send(null);
    },
  );
}
