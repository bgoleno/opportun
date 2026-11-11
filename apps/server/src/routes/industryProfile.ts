// The industry profile's API (https://github.com/bgoleno/opportun/issues/219, #190 N4a). See
// lib/industryProfile.ts for what the suggestion sends, and repos/industryProfile.ts for the rows.
import { AiUnavailableError } from '@opportun/ai';
import { isNaicsCode, naicsTitle, NAICS_TIERS } from '@opportun/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HttpError } from '../lib/errors';
import { suggestIndustries } from '../lib/industryProfile';
import { requireUser } from '../repos/base';
import {
  addIndustry,
  confirmIndustry,
  listIndustryProfile,
  removeIndustry,
  type IndustryProfileRow,
} from '../repos/industryProfile';
import { latestBaseResume } from '../repos/resumes';
import { storeFor } from './resumes';
import { aiUnavailable } from './tailoring';

const RowView = z.object({
  code: z.string(),
  title: z.string(),
  tier: z.enum(NAICS_TIERS),
  source: z.string(),
  reason: z.string().nullable(),
  confirmed: z.boolean(),
});
const CodeParams = z.object({ code: z.string().min(1).max(20) });
const AddBody = z.object({ code: z.string().max(20), tier: z.enum(NAICS_TIERS) });

const view = (r: IndustryProfileRow): z.infer<typeof RowView> => ({
  code: r.naicsCode,
  title: naicsTitle(r.naicsCode) ?? r.naicsCode,
  tier: r.tier,
  source: r.source,
  reason: r.reason,
  confirmed: r.confirmed,
});

export async function industryProfileRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  api.get(
    '/discovery/industry-profile',
    { schema: { response: { 200: z.object({ items: z.array(RowView) }) } } },
    async (req) => ({ items: (await listIndustryProfile(db, requireUser(req))).map(view) }),
  );

  /** One AI call, made while the request waits, as resume.match is. Only ever on the user's ask. */
  api.post(
    '/discovery/industry-profile/suggest',
    {
      schema: {
        response: { 200: z.object({ suggested: z.number().int(), items: z.array(RowView) }) },
      },
    },
    async (req) => {
      const ctx = requireUser(req);
      const base = await latestBaseResume(db, ctx);
      // A store has many ways to fail, in its own codes. The panel asked for a resume, so it is told
      // that this is what failed, with the store's code to pick the fix by. Only a code goes out:
      // anything else a store throws is in the log, not the answer.
      const readResume =
        base === undefined
          ? null
          : async () => {
              try {
                return await storeFor(app, base.store).readText(ctx, base.docRef);
              } catch (err) {
                req.log.warn(
                  { err, 'opportun.resume.id': base.id },
                  'could not read the base resume',
                );
                throw new HttpError(409, 'resume_unreadable', undefined, {
                  reason: err instanceof HttpError ? err.code : 'read_failed',
                  title: base.title,
                });
              }
            };
      try {
        const { suggested } = await suggestIndustries(db, ctx, readResume);
        return { suggested, items: (await listIndustryProfile(db, ctx)).map(view) };
      } catch (err) {
        if (err instanceof AiUnavailableError) {
          const http = await aiUnavailable(db, ctx, 'discovery.industry_profile', err);
          // The router keeps a 401 as provider_error, with a flag. Trying again later will not help
          // with a rejected key, so here it is a reason of its own, as on a queue card (#275).
          throw err.keyRejected
            ? new HttpError(http.statusCode, http.code, undefined, {
                ...http.details,
                reason: 'key_rejected',
              })
            : http;
        }
        throw err;
      }
    },
  );

  /** Adds a code the user chose: only one from the table is ever stored. */
  api.post(
    '/discovery/industry-profile',
    { schema: { body: AddBody, response: { 200: RowView } } },
    async (req) => {
      if (!isNaicsCode(req.body.code)) throw new HttpError(422, 'unknown_naics_code');
      return view(await addIndustry(db, requireUser(req), req.body.code, req.body.tier));
    },
  );

  api.post(
    '/discovery/industry-profile/:code/confirm',
    { schema: { params: CodeParams, response: { 200: RowView } } },
    async (req) => view(await confirmIndustry(db, requireUser(req), req.params.code)),
  );

  api.delete(
    '/discovery/industry-profile/:code',
    { schema: { params: CodeParams, response: { 204: z.null() } } },
    async (req, reply) => {
      await removeIndustry(db, requireUser(req), req.params.code);
      return reply.code(204).send(null);
    },
  );
}
