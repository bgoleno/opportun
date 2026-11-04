// GET /discovery/network-companies (https://github.com/bgoleno/opportun/issues/216): the
// companies the user has a current contact at, for the Companies tab. Read-only, from the user's
// own rows: no AI call and no outbound request. Following one is POST /companies/:id/follow
// (companySuggestions.ts), which does what accepting a suggestion does.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { listNetworkCompanies } from '../repos/networkCompanies';
import { companyViews, CompanyViewSchema } from './companies';

const NetworkCompaniesQuery = z.object({
  showDenied: z.enum(['true', 'false']).default('false'),
});

const NetworkCompanySchema = z.object({
  company: CompanyViewSchema,
  board: z.enum(['found', 'not_found', 'not_checked']),
  contactCount: z.number().int(),
  strongestStrength: z.number().int().nullable(),
  contacts: z.array(
    z.object({ id: z.string(), name: z.string(), strength: z.number().int().nullable() }),
  ),
});

export async function networkCompanyRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  api.get(
    '/discovery/network-companies',
    {
      schema: {
        querystring: NetworkCompaniesQuery,
        response: { 200: z.object({ items: z.array(NetworkCompanySchema) }) },
      },
    },
    async (req) => {
      const ctx = app.requireUser(req);
      const items = await listNetworkCompanies(db, ctx, {
        showDenied: req.query.showDenied === 'true',
      });
      const views = new Map(
        (
          await companyViews(
            db,
            ctx,
            items.map((i) => i.company),
          )
        ).map((v) => [v.id, v]),
      );
      return { items: items.map((item) => ({ ...item, company: views.get(item.company.id)! })) };
    },
  );
}
