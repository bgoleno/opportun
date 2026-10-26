// Companies (design 4.3). There is no DELETE: denied companies are kept so they are
// never re-suggested (FR-D8), and deleting would cascade to opportunities.
//
// Responses carry the ATS detection state (FR-D9): atsKind/atsRef/atsVerifiedAt from the row,
// atsDetectPending while a detection job is queued or running, and needsCareersUrl when nothing
// was found and the company has no careers URL to scan (the UI asks the user for one).
//
// Following a company (status 'followed', by PATCH or by accepting a suggestion) enables its
// board's discovery source on the user's default cron; any other status disables it (FR-D5).
import { COMPANY_STATUSES, CompanySchema } from '@opportun/core';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../db/client';
import { jobs } from '../db/schema';
import {
  ATS_DETECT_KIND,
  atsDetectDedupeKey,
  enqueueAtsDetect,
  syncFollowedCompany,
} from '../jobs/atsDetect';
import { countPendingFromCompany } from '../lib/deniedCompanies';
import type { UserCtx } from '../repos/base';
import {
  COMPANY_SORTS,
  createCompany,
  getCompany,
  listCompanies,
  updateCompany,
  type Company,
} from '../repos/companies';
import { HttpUrl, IdParams, listQuery, optionalText, pageOf } from './common';

const companyFields = {
  name: z.string().trim().min(1).max(200),
  domain: optionalText(253),
  careersUrl: HttpUrl.nullish(),
  status: z.enum(COMPANY_STATUSES),
  notes: optionalText(20_000),
};
const CompanyCreate = z.object({
  ...companyFields,
  status: companyFields.status.default('none'),
});
const CompanyPatch = z.object(companyFields).partial();
const CompanyQuery = listQuery([...COMPANY_SORTS.keys()]).extend({
  q: z.string().trim().min(1).max(200).optional(),
  status: z.enum(COMPANY_STATUSES).optional(),
});

export const CompanyViewSchema = CompanySchema.extend({
  atsDetectPending: z.boolean(),
  needsCareersUrl: z.boolean(),
});
type CompanyView = z.infer<typeof CompanyViewSchema>;

/** Companies with an unfinished detection job, among `ids`. */
async function pendingDetection(db: Db, ctx: UserCtx, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const keys = new Map(ids.map((id) => [atsDetectDedupeKey(id), id]));
  const rows = await db
    .select({ dedupeKey: jobs.dedupeKey })
    .from(jobs)
    .where(
      and(
        eq(jobs.kind, ATS_DETECT_KIND),
        eq(jobs.userId, ctx.userId),
        inArray(jobs.status, ['pending', 'running']),
        inArray(jobs.dedupeKey, [...keys.keys()]),
      ),
    )
    .all();
  return new Set(rows.map((r) => keys.get(r.dedupeKey ?? '')).filter((id) => id !== undefined));
}

export async function companyViews(db: Db, ctx: UserCtx, rows: Company[]): Promise<CompanyView[]> {
  const pending = await pendingDetection(
    db,
    ctx,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({
    ...r,
    atsDetectPending: pending.has(r.id),
    needsCareersUrl: r.atsKind === 'none' && r.careersUrl === null,
  }));
}

export const companyView = async (db: Db, ctx: UserCtx, row: Company): Promise<CompanyView> =>
  (await companyViews(db, ctx, [row]))[0]!;

export async function companyRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  api.get(
    '/companies',
    { schema: { querystring: CompanyQuery, response: { 200: pageOf(CompanyViewSchema) } } },
    async (req) => {
      const ctx = app.requireUser(req);
      const page = await listCompanies(db, ctx, req.query);
      return { items: await companyViews(db, ctx, page.items), total: page.total };
    },
  );

  api.post(
    '/companies',
    { schema: { body: CompanyCreate, response: { 201: CompanyViewSchema } } },
    async (req, reply) => {
      const ctx = app.requireUser(req);
      const company = await createCompany(db, ctx, req.body);
      if (company.status === 'followed') await syncFollowedCompany(db, ctx, company);
      return reply.code(201).send(await companyView(db, ctx, company));
    },
  );

  api.get(
    '/companies/:id',
    { schema: { params: IdParams, response: { 200: CompanyViewSchema } } },
    async (req) => {
      const ctx = app.requireUser(req);
      return await companyView(db, ctx, await getCompany(db, ctx, req.params.id));
    },
  );

  api.patch(
    '/companies/:id',
    { schema: { params: IdParams, body: CompanyPatch, response: { 200: CompanyViewSchema } } },
    async (req) => {
      const ctx = app.requireUser(req);
      const company = await updateCompany(db, ctx, req.params.id, req.body);
      // FR-D5: a status change starts or stops polling the company's board.
      if (req.body.status !== undefined) await syncFollowedCompany(db, ctx, company);
      return await companyView(db, ctx, company);
    },
  );

  // FR-D9: queue board detection for the company (deduped while one is unfinished).
  api.post(
    '/companies/:id/detect-ats',
    {
      schema: {
        params: IdParams,
        response: { 202: z.object({ jobId: z.string() }) },
      },
    },
    async (req, reply) => {
      const ctx = app.requireUser(req);
      const company = await getCompany(db, ctx, req.params.id);
      return reply.code(202).send({ jobId: await enqueueAtsDetect(db, ctx, company.id) });
    },
  );

  /**
   * How many currently pending results match this company (issue #199), shown right after
   * denying it: existing queue items stay until the user clears them, so this says how many
   * there are and leaves the clearing to #184's bulk triage rather than acting here itself.
   */
  api.get(
    '/companies/:id/pending-count',
    { schema: { params: IdParams, response: { 200: z.object({ count: z.number().int() }) } } },
    async (req) => {
      const ctx = app.requireUser(req);
      const company = await getCompany(db, ctx, req.params.id);
      return { count: await countPendingFromCompany(db, ctx, company) };
    },
  );
}
