// Companies (design 4.3). There is no DELETE: denied companies are kept so they are
// never re-suggested (FR-D8), and deleting would cascade to opportunities.
//
// Responses carry the ATS detection state (FR-D9): atsKind/atsRef/atsVerifiedAt from the row,
// atsDetectPending while a detection job is queued or running, and needsCareersUrl when nothing
// was found and the company has no careers URL to scan (the UI asks the user for one).
//
// Following a company (status 'followed', by PATCH or by accepting a suggestion) enables its
// board's discovery source on the user's default cron; any other status disables it (FR-D5).
import { COMPANY_STATUSES, CompanySchema, isNaicsCode } from '@opportun/core';
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
import {
  BOARD_PROBE_KIND,
  boardProbeDedupeKey,
  enqueueBoardProbe,
} from '../jobs/companyBoardProbe';
import { countPendingFromCompany } from '../lib/deniedCompanies';
import { HttpError } from '../lib/errors';
import { rateLimit } from '../lib/rateLimit';
import type { UserCtx } from '../repos/base';
import {
  COMPANY_SORTS,
  createCompany,
  getCompany,
  listCompanies,
  setCompanyIndustry,
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
  /**
   * The board probe's result (#221, #301): when it ran, how many postings the board had open and how
   * many of them the pre-filter passes. Null until it has run, and where there is no board to count.
   * boardProbePending is true while a probe job is queued or running.
   */
  boardProbedAt: z.number().int().nullable(),
  boardOpenJobs: z.number().int().nullable(),
  boardPrefilterMatches: z.number().int().nullable(),
  boardProbePending: z.boolean(),
});
type CompanyView = z.infer<typeof CompanyViewSchema>;

/** Companies with an unfinished job of `kind` (a detection or a board probe), among `ids`. */
async function pendingJobs(
  db: Db,
  ctx: UserCtx,
  kind: string,
  dedupeKey: (companyId: string) => string,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const keys = new Map(ids.map((id) => [dedupeKey(id), id]));
  const rows = await db
    .select({ dedupeKey: jobs.dedupeKey })
    .from(jobs)
    .where(
      and(
        eq(jobs.kind, kind),
        eq(jobs.userId, ctx.userId),
        inArray(jobs.status, ['pending', 'running']),
        inArray(jobs.dedupeKey, [...keys.keys()]),
      ),
    )
    .all();
  return new Set(rows.map((r) => keys.get(r.dedupeKey ?? '')).filter((id) => id !== undefined));
}

export async function companyViews(db: Db, ctx: UserCtx, rows: Company[]): Promise<CompanyView[]> {
  const ids = rows.map((r) => r.id);
  const pending = await pendingJobs(db, ctx, ATS_DETECT_KIND, atsDetectDedupeKey, ids);
  const probing = await pendingJobs(db, ctx, BOARD_PROBE_KIND, boardProbeDedupeKey, ids);
  return rows.map((r) => ({
    ...r,
    atsDetectPending: pending.has(r.id),
    needsCareersUrl: r.atsKind === 'none' && r.careersUrl === null,
    boardProbePending: probing.has(r.id),
  }));
}

export const companyView = async (db: Db, ctx: UserCtx, row: Company): Promise<CompanyView> =>
  (await companyViews(db, ctx, [row]))[0]!;

/**
 * Check board clicks per user per hour (sec's ruling on https://github.com/bgoleno/opportun/issues/301).
 * Each company can be checked once, but a user can add companies freely, so that bounds each one and
 * not the user's total; the probe's cap of 2 is for the whole app, so one user's backlog would delay
 * everyone's probes; and the board vendors see the instance's one shared address. 30 lets a user
 * check every company one weekly suggestion run proposes (up to 15) and as many from the network in
 * one sitting. Reasoned, not measured: no real use exists yet. Change it here if real use says so.
 */
export const CHECK_BOARD_USER_LIMIT = { limit: 30, windowMs: 60 * 60 * 1000 };

export async function companyRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  // One set of buckets for this app, keyed on the signed-in user and nothing from the request.
  const checkBoardLimit = rateLimit({
    ...CHECK_BOARD_USER_LIMIT,
    reason: 'per_user',
    keyFn: (req) => `check-board|${app.requireUser(req).userId}`,
  });

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

  // The user's correction of a company's industry (#220): only a code from the table, and it stands.
  api.put(
    '/companies/:id/industry',
    {
      schema: {
        params: IdParams,
        body: z.object({ code: z.string().max(20) }),
        response: { 200: CompanyViewSchema },
      },
    },
    async (req) => {
      if (!isNaicsCode(req.body.code)) throw new HttpError(422, 'unknown_naics_code');
      const ctx = app.requireUser(req);
      return await companyView(
        db,
        ctx,
        await setCompanyIndustry(db, ctx, req.params.id, req.body.code),
      );
    },
  );

  // Check board (#301): the user's click queues the board probe for this one company, and nothing
  // else probes a company the user has not asked about. Refused for a company that is not a
  // candidate (status none or suggested) or that was already checked, so the button hidden in the
  // client is not the bound. Limited per user (above), before any lookup or enqueue.
  api.post(
    '/companies/:id/check-board',
    {
      preHandler: checkBoardLimit,
      schema: { params: IdParams, response: { 202: z.object({ jobId: z.string() }) } },
    },
    async (req, reply) => {
      const ctx = app.requireUser(req);
      const company = await getCompany(db, ctx, req.params.id);
      if (company.status !== 'none' && company.status !== 'suggested') {
        throw new HttpError(409, 'not_a_candidate');
      }
      // A probe that failed leaves no board recorded, so the company can be asked again.
      if (company.atsKind !== null) throw new HttpError(409, 'already_checked');
      return reply.code(202).send({ jobId: await enqueueBoardProbe(db, ctx, company.id) });
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
