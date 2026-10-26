// Resume tracking API (FR-R1, R2, R3). Documents live in the user's Google Drive; this API
// keeps the tracking rows (status, opportunity link, parent base) and reads document text.
import { RESUME_KINDS, RESUME_STATUSES, RESUME_STORES, type ResumeStore } from '@opportun/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { DocumentStore } from '../adapters/documentStore';
import { docUrl, searchDriveDocuments } from '../adapters/googleDocs';
import { readDocumentStorePref, readRrBaseUrl, rrResumeUrl } from '../adapters/reactiveResume';
import { users } from '../db/schema';
import { requireUser } from '../repos/base';
import { getOpportunity } from '../repos/opportunities';
import {
  deleteResume,
  getResume,
  insertResume,
  listResumes,
  NAMING_VARIABLES,
  readNamingTemplate,
  renderResumeName,
  roleSlug,
  unknownNamingVars,
  updateResume,
  writeNamingTemplate,
  type ResumeRow,
} from '../repos/resumes';
import { IdParams, pageOf } from './common';

export const ResumeView = z.object({
  id: z.string(),
  kind: z.enum(RESUME_KINDS),
  opportunityId: z.string().nullable(),
  title: z.string(),
  store: z.enum(RESUME_STORES),
  docRef: z.string(),
  url: z.string().nullable(),
  parentResumeId: z.string().nullable(),
  status: z.enum(RESUME_STATUSES),
  submittedAt: z.number().int().nullable(),
  submittedTo: z.string().nullable(),
  /** Set instead of a hard delete when a submitted resume is removed (#70). */
  archivedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

/**
 * The document store a resume lives in. Each row keeps its own store, so changing the
 * preference for new resumes never strands existing ones.
 */
export function storeFor(app: FastifyInstance, store: ResumeStore): DocumentStore {
  if (store === 'google_doc') return app.documentStore;
  if (store === 'reactive_resume') return app.reactiveResumeStore;
  return app.localFileStore;
}

/** The browser link for a resume; `rrBaseUrl` is the owner's Reactive Resume origin, if any. */
function resumeUrl(r: ResumeRow, rrBaseUrl: string | null): string | null {
  if (r.store === 'google_doc') return docUrl(r.docRef);
  if (r.store === 'reactive_resume' && rrBaseUrl !== null) return rrResumeUrl(rrBaseUrl, r.docRef);
  return null;
}

export function toResumeView(
  r: ResumeRow,
  rrBaseUrl: string | null = null,
): z.infer<typeof ResumeView> {
  return {
    id: r.id,
    kind: r.kind,
    opportunityId: r.opportunityId,
    title: r.title,
    store: r.store,
    docRef: r.docRef,
    url: resumeUrl(r, rrBaseUrl),
    parentResumeId: r.parentResumeId,
    status: r.status,
    submittedAt: r.submittedAt,
    submittedTo: r.submittedTo,
    archivedAt: r.archivedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

const Id = z.string().min(1).max(64);
/**
 * Without `store`, the user's document store preference decides (default Google). An
 * `opportunityId` registers and attaches in one step (#77): the row is created as a tailored
 * resume with no parent, since nothing was copied, rather than forced to `base`.
 */
const RegisterBody = z.object({
  store: z.enum(['google_doc', 'reactive_resume']).optional(),
  docRef: z.string().trim().min(1).max(500),
  opportunityId: Id.optional(),
});
const TailoredBody = z.object({ baseResumeId: Id, opportunityId: Id });
const CreateBody = z.union([RegisterBody, TailoredBody]);
const PatchBody = z
  .object({
    title: z.string().trim().min(1).max(300),
    status: z.enum(RESUME_STATUSES),
    submittedTo: z.string().trim().min(1).max(300),
    submittedAt: z.number().int().nonnegative(),
    /**
     * `.nullable()`, not `.optional()`, on the field itself: with `.partial()` on the whole
     * object, presence and absence stay distinct (#77). Absent means leave the link alone;
     * `null` means detach; a string attaches or moves it. Collapsing these (e.g. reading both
     * "absent" and "null" as "nothing to do") would make detach silently do nothing.
     */
    opportunityId: Id.nullable(),
  })
  .partial()
  .strict();
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  opportunityId: Id.optional(),
  kind: z.enum(RESUME_KINDS).optional(),
});
/** Drive search for the attach-by-picking modal (#136): read-only, one page per call via
 *  Drive's own pageToken (files.list has no offset to page by). */
const DriveSearchQuery = z.object({
  q: z.string().trim().max(500).optional(),
  pageToken: z.string().trim().max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const DriveSearchHit = z.object({
  id: z.string(),
  name: z.string(),
  modifiedTime: z.string(),
  folderName: z.string().nullable(),
});
const DriveSearchResult = z.object({
  files: z.array(DriveSearchHit),
  nextPageToken: z.string().optional(),
});

const TemplateBody = z.object({
  template: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .superRefine((t, ctx) => {
      const unknown = unknownNamingVars(t);
      if (unknown.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message: `Unknown placeholder(s): ${unknown.join(', ')}. Available: ${NAMING_VARIABLES.join(', ')}`,
        });
      }
    }),
});

export async function resumeRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  api.get(
    '/resumes',
    { schema: { querystring: ListQuery, response: { 200: pageOf(ResumeView) } } },
    async (req) => {
      const ctx = requireUser(req);
      const page = await listResumes(db, ctx, req.query);
      const rrBase = await readRrBaseUrl(db, ctx);
      return { items: page.items.map((r) => toResumeView(r, rrBase)), total: page.total };
    },
  );

  // Search-first attach (#136): the requesting user's own Drive, through their own Google
  // connection (requireUser scopes it; there is no cross-user lookup here). A 409 with code
  // google_not_connected/google_not_configured, google_reauth_required or google_scope_missing
  // (searchDriveDocuments -> GoogleConn.getClient / googleHttpError) distinguishes "not
  // connected at all" and "connection exists but the token no longer works" from a plain empty
  // `files: []` ("no documents match"), so the client can tell the person which of those it is.
  api.get(
    '/resumes/drive-search',
    { schema: { querystring: DriveSearchQuery, response: { 200: DriveSearchResult } } },
    async (req) => {
      const ctx = requireUser(req);
      return searchDriveDocuments(db, app.googleConn, app.google, ctx, req.query);
    },
  );

  api.post(
    '/resumes',
    { schema: { body: CreateBody, response: { 201: ResumeView } } },
    async (req, reply) => {
      const ctx = requireUser(req);
      const body = req.body;
      const rrBase = await readRrBaseUrl(db, ctx);
      if ('docRef' in body) {
        // User-scoped: another user's opportunity is a 404, same as the tailored-copy path below.
        const opportunity =
          body.opportunityId === undefined
            ? null
            : await getOpportunity(db, ctx, body.opportunityId);
        const store =
          body.store ??
          ((await readDocumentStorePref(db, ctx)) === 'reactive_resume'
            ? 'reactive_resume'
            : 'google_doc');
        const meta = await storeFor(app, store).registerExisting(ctx, body.docRef);
        const row = await insertResume(db, ctx, {
          kind: opportunity === null ? 'base' : 'tailored',
          title: meta.title,
          store,
          docRef: meta.docRef,
          opportunityId: opportunity?.id ?? null,
          parentResumeId: null,
        });
        return reply.code(201).send(toResumeView(row, rrBase));
      }
      // Both lookups are user-scoped: another user's base or opportunity is a 404.
      const base = await getResume(db, ctx, body.baseResumeId);
      const opportunity = await getOpportunity(db, ctx, body.opportunityId);
      // The copy lives where its base lives.
      const docs = storeFor(app, base.store);
      const displayName =
        (
          await db
            .select({ n: users.displayName })
            .from(users)
            .where(eq(users.id, ctx.userId))
            .get()
        )?.n ?? '';
      const name = renderResumeName(await readNamingTemplate(db, ctx), {
        displayName,
        company: opportunity.companyName,
        roleSlug: roleSlug(opportunity.title),
      });
      const meta = await docs.copyFrom(ctx, base.docRef, name);
      const row = await insertResume(db, ctx, {
        kind: 'tailored',
        title: meta.title,
        store: base.store,
        docRef: meta.docRef,
        opportunityId: opportunity.id,
        parentResumeId: base.id,
      });
      return reply.code(201).send(toResumeView(row, rrBase));
    },
  );

  api.get(
    '/resumes/:id',
    { schema: { params: IdParams, response: { 200: ResumeView } } },
    async (req) => {
      const ctx = requireUser(req);
      return toResumeView(await getResume(db, ctx, req.params.id), await readRrBaseUrl(db, ctx));
    },
  );

  api.patch(
    '/resumes/:id',
    { schema: { params: IdParams, body: PatchBody, response: { 200: ResumeView } } },
    async (req) => {
      const ctx = requireUser(req);
      // User-scoped existence check on the way in (#77): another user's opportunity is a 404,
      // not a successful link. Only when attaching/moving; absent or null (detach) needs none.
      const { opportunityId } = req.body;
      if (opportunityId !== undefined && opportunityId !== null) {
        await getOpportunity(db, ctx, opportunityId);
      }
      const row = await updateResume(db, ctx, req.params.id, req.body);
      return toResumeView(row, await readRrBaseUrl(db, ctx));
    },
  );

  api.delete(
    '/resumes/:id',
    {
      schema: {
        params: IdParams,
        response: {
          200: z.discriminatedUnion('outcome', [
            z.object({ outcome: z.literal('deleted') }),
            z.object({ outcome: z.literal('archived'), resume: ResumeView }),
          ]),
        },
      },
    },
    async (req) => {
      const ctx = requireUser(req);
      const result = await deleteResume(db, ctx, req.params.id);
      if (result.outcome === 'deleted') return { outcome: 'deleted' as const };
      return {
        outcome: 'archived' as const,
        resume: toResumeView(result.row, await readRrBaseUrl(db, ctx)),
      };
    },
  );

  api.get(
    '/resumes/:id/text',
    { schema: { params: IdParams, response: { 200: z.object({ text: z.string() }) } } },
    async (req) => {
      const ctx = requireUser(req);
      const resume = await getResume(db, ctx, req.params.id);
      return { text: await storeFor(app, resume.store).readText(ctx, resume.docRef) };
    },
  );

  api.get(
    '/settings/resume-naming-template',
    { schema: { response: { 200: z.object({ template: z.string() }) } } },
    async (req) => ({ template: await readNamingTemplate(db, requireUser(req)) }),
  );

  api.put(
    '/settings/resume-naming-template',
    { schema: { body: TemplateBody, response: { 200: z.object({ template: z.string() }) } } },
    async (req) => {
      await writeNamingTemplate(db, requireUser(req), req.body.template);
      return { template: req.body.template };
    },
  );
}
