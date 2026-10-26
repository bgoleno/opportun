// The company suggestion queue (FR-D8). Suggestions are companies with status 'suggested'
// (written by the company.suggest job). Accept follows the company and queues its ATS board
// detection; deny marks it 'denied', which is permanent: the suggest job never proposes a
// denied company again. Neither acts on a company that is not a suggestion (409), so a denied
// company cannot be accepted from the queue; repeating the same decision is a no-op.
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Db } from '../db/client';
import { companies } from '../db/schema';
import { enqueueAtsDetect, syncFollowedCompany } from '../jobs/atsDetect';
import { HttpError } from '../lib/errors';
import type { UserCtx } from '../repos/base';
import { COMPANY_SORTS, getCompany, listCompanies, type Company } from '../repos/companies';
import { IdParams, listQuery, pageOf } from './common';
import { companyView, companyViews, CompanyViewSchema } from './companies';

const SuggestionQuery = listQuery([...COMPANY_SORTS.keys()]);

/** suggested -> `to`; already `to` is a no-op; any other status is a 409. */
async function decide(
  db: Db,
  ctx: UserCtx,
  id: string,
  to: 'followed' | 'denied',
): Promise<{ company: Company; changed: boolean }> {
  const row = await db
    .update(companies)
    .set({ status: to, updatedAt: Date.now() })
    .where(
      and(
        eq(companies.userId, ctx.userId),
        eq(companies.id, id),
        eq(companies.status, 'suggested'),
      ),
    )
    .returning()
    .get();
  if (row !== undefined) return { company: row, changed: true };
  const current = await getCompany(db, ctx, id);
  if (current.status === to) return { company: current, changed: false };
  throw new HttpError(409, 'not_suggested', 'the company is not a pending suggestion');
}

export async function companySuggestionRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  api.get(
    '/companies/suggestions',
    { schema: { querystring: SuggestionQuery, response: { 200: pageOf(CompanyViewSchema) } } },
    async (req) => {
      const ctx = app.requireUser(req);
      const page = await listCompanies(db, ctx, {
        ...req.query,
        sort: req.query.sort ?? '-createdAt',
        status: 'suggested',
      });
      return { items: await companyViews(db, ctx, page.items), total: page.total };
    },
  );

  api.post(
    '/companies/:id/accept',
    { schema: { params: IdParams, response: { 200: CompanyViewSchema } } },
    async (req) => {
      const ctx = app.requireUser(req);
      const { company, changed } = await decide(db, ctx, req.params.id, 'followed');
      if (changed) {
        await syncFollowedCompany(db, ctx, company);
        await enqueueAtsDetect(db, ctx, company.id);
      }
      return await companyView(db, ctx, company);
    },
  );

  api.post(
    '/companies/:id/deny',
    { schema: { params: IdParams, response: { 200: CompanyViewSchema } } },
    async (req) => {
      const ctx = app.requireUser(req);
      return await companyView(db, ctx, (await decide(db, ctx, req.params.id, 'denied')).company);
    },
  );
}
