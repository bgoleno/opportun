// The company suggestion queue (FR-D8). Suggestions are companies with status 'suggested'
// (written by the company.suggest job). Accept follows the company and queues its ATS board
// detection; deny marks it 'denied', which is permanent: the suggest job never proposes a
// denied company again. Neither acts on a company that is not a suggestion (409), so a denied
// company cannot be accepted from the queue; repeating the same decision is a no-op.
//
// Follow (https://github.com/bgoleno/opportun/issues/216) is accept for a company that was never
// suggested, such as one in the user's network: from 'none' or 'suggested' it follows the company
// and queues its board detection, exactly as accept does. A denied company is refused (409), so a
// deny stays a deny until the user undoes it on purpose.
import { and, eq, inArray } from 'drizzle-orm';
import type { CompanyStatus } from '@opportun/core';
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

/** One of `from` -> `to`; already `to` is a no-op; any other status is a 409 with `refusal`. */
async function decide(
  db: Db,
  ctx: UserCtx,
  id: string,
  to: 'followed' | 'denied',
  from: readonly CompanyStatus[] = ['suggested'],
  refusal: { code: string; message: string } = {
    code: 'not_suggested',
    message: 'the company is not a pending suggestion',
  },
): Promise<{ company: Company; changed: boolean }> {
  const row = await db
    .update(companies)
    .set({ status: to, updatedAt: Date.now() })
    .where(
      and(
        eq(companies.userId, ctx.userId),
        eq(companies.id, id),
        inArray(companies.status, [...from]),
      ),
    )
    .returning()
    .get();
  if (row !== undefined) return { company: row, changed: true };
  const current = await getCompany(db, ctx, id);
  if (current.status === to) return { company: current, changed: false };
  throw new HttpError(409, refusal.code, refusal.message);
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
    '/companies/:id/follow',
    { schema: { params: IdParams, response: { 200: CompanyViewSchema } } },
    async (req) => {
      const ctx = app.requireUser(req);
      const { company, changed } = await decide(
        db,
        ctx,
        req.params.id,
        'followed',
        ['none', 'suggested'],
        { code: 'company_denied', message: 'the company is denied: undeny it first' },
      );
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
