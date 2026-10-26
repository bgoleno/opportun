// Reactive Resume integration (FR-R7): the instance address and API key, a validate probe,
// and the per-user document store preference. The key goes into the vault once and never
// comes back out over HTTP (NFR-SEC4).
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  clearRrConfig,
  DOCUMENT_STORE_PREFS,
  DOCUMENT_STORE_SETTING,
  parseRrBaseUrl,
  readDocumentStorePref,
  readRrBaseUrl,
  readRrConfig,
  rrKeySet,
  RR_TARGET_VERSIONS,
  validateReactiveResume,
  writeRrConfig,
} from '../adapters/reactiveResume';
import { audit } from '../lib/audit';
import { HttpError } from '../lib/errors';
import { requireUser, type UserCtx } from '../repos/base';
import { writeUserSetting } from '../repos/userSettings';

const StatusSchema = z.object({
  baseUrl: z.string().nullable(),
  keySet: z.boolean(),
  connected: z.boolean(),
  targetVersions: z.array(z.string()),
});
const PutBody = z
  .object({
    baseUrl: z.string().trim().min(1).max(500),
    // Sent as the x-api-key header: visible ASCII only, so a pasted space, line break or
    // non-ASCII character is a clear 400 here rather than an "unreachable" later.
    apiKey: z
      .string()
      .trim()
      .min(8)
      .max(4096)
      .regex(/^[\x21-\x7e]+$/, {
        message: 'The API key may only contain visible ASCII characters (no spaces).',
      })
      .optional(),
  })
  .strict();
const ValidationSchema = z.object({
  ok: z.boolean(),
  version: z.string().nullable(),
  error: z.string().nullable(),
});
const StoreBody = z.object({ store: z.enum(DOCUMENT_STORE_PREFS) }).strict();

export async function reactiveResumeRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  async function status(ctx: UserCtx): Promise<z.infer<typeof StatusSchema>> {
    const baseUrl = await readRrBaseUrl(db, ctx);
    const keySet = await rrKeySet(db, ctx);
    return {
      baseUrl,
      keySet,
      connected: baseUrl !== null && keySet,
      targetVersions: [...RR_TARGET_VERSIONS],
    };
  }

  api.get(
    '/integrations/reactive-resume',
    { schema: { response: { 200: StatusSchema } } },
    async (req) => await status(requireUser(req)),
  );

  api.put(
    '/integrations/reactive-resume',
    { schema: { body: PutBody, response: { 200: StatusSchema } } },
    async (req) => {
      const ctx = requireUser(req);
      const baseUrl = parseRrBaseUrl(req.body.baseUrl);
      await writeRrConfig(db, ctx, baseUrl, req.body.apiKey);
      await audit(db, 'integration.reactive_resume_saved', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { baseUrl, keyChanged: req.body.apiKey !== undefined },
      });
      return await status(ctx);
    },
  );

  api.post(
    '/integrations/reactive-resume/validate',
    { schema: { response: { 200: ValidationSchema } } },
    async (req) => {
      const cfg = await readRrConfig(db, requireUser(req));
      if (cfg === undefined) throw new HttpError(409, 'reactive_resume_not_connected');
      return validateReactiveResume(app.reactiveResumeFetch, cfg);
    },
  );

  api.delete(
    '/integrations/reactive-resume',
    { schema: { response: { 204: z.null() } } },
    async (req, reply) => {
      const ctx = requireUser(req);
      await clearRrConfig(db, ctx);
      await audit(db, 'integration.reactive_resume_removed', {
        userId: ctx.userId,
        ip: req.ip,
      });
      return reply.code(204).send(null);
    },
  );

  api.get(
    '/settings/document-store',
    { schema: { response: { 200: StoreBody } } },
    async (req) => ({ store: await readDocumentStorePref(db, requireUser(req)) }),
  );

  // Where NEW base resumes go. Existing resumes keep the store they were registered in.
  api.put(
    '/settings/document-store',
    { schema: { body: StoreBody, response: { 200: StoreBody } } },
    async (req) => {
      const ctx = requireUser(req);
      if (req.body.store === 'reactive_resume' && !(await status(ctx)).connected) {
        throw new HttpError(
          409,
          'reactive_resume_not_connected',
          'Connect Reactive Resume before choosing it.',
        );
      }
      await writeUserSetting(db, ctx, DOCUMENT_STORE_SETTING, req.body.store);
      return { store: req.body.store };
    },
  );
}
