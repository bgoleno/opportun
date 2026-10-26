// Import and export API (FR-I1, I2, I3). An upload is validated and queued as an `import`
// job; its progress and report are read back by job id. The export is built from the
// caller's rows only and streamed as a zip.
import multipart from '@fastify/multipart';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { JOB_STATUSES, jobs } from '../db/schema';
import { enqueue } from '../jobs/runner';
import { audit } from '../lib/audit';
import { HttpError, notFound } from '../lib/errors';
import { buildExport, zipStream } from '../lib/exporter';
import {
  IMPORT_JOB_KIND,
  MAX_PACK_BYTES,
  PackError,
  packFromFiles,
  packFromZip,
  type ImportPack,
  type ImportResult,
} from '../lib/importer';
import {
  LINKEDIN_IMPORT_JOB_KIND,
  linkedInPackFromZip,
  type LinkedInPack,
} from '../lib/linkedinExport';
import { requireUser } from '../repos/base';

const MAX_FILES = 2000;
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

const ImportStatus = z.object({
  id: z.string(),
  status: z.enum(JOB_STATUSES),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  progress: z.object({ processed: z.number().int(), total: z.number().int() }).nullable(),
  report: z
    .object({
      created: z.number().int(),
      updated: z.number().int(),
      skipped: z.number().int(),
      /** Only the importers that apply the ingestion window report this (issue #53). */
      outsideWindow: z.number().int().optional(),
      /** Only the LinkedIn import reports this (issue #132). */
      strippedConnections: z.number().int().optional(),
      errors: z.array(z.object({ line: z.number().int(), message: z.string() })),
    })
    .nullable(),
});

/** Job kinds whose status and report GET /imports/:jobId serves. */
const IMPORT_KINDS = [IMPORT_JOB_KIND, LINKEDIN_IMPORT_JOB_KIND];

const isZip = (name: string, data: Buffer): boolean =>
  name.toLowerCase().endsWith('.zip') || data.subarray(0, 4).equals(ZIP_MAGIC);

function yyyymmdd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

export async function importExportRoutes(app: FastifyInstance): Promise<void> {
  await app.register(multipart, {
    // Directory uploads name each part by its relative path; it only indexes the pack.
    preservePath: true,
    limits: {
      fileSize: MAX_PACK_BYTES + 1,
      files: MAX_FILES,
      parts: MAX_FILES + 5,
      fields: 5,
      fieldSize: 1024,
      headerPairs: 20,
    },
  });
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  api.post(
    '/imports',
    { schema: { response: { 202: z.object({ jobId: z.string() }) } } },
    async (req, reply) => {
      const ctx = requireUser(req);
      if (!req.isMultipart()) throw new HttpError(415, 'unsupported_media_type');
      const files: { name: string; data: Buffer }[] = [];
      let total = 0;
      for await (const part of req.files()) {
        const data = await part.toBuffer();
        total += data.length;
        if (total > MAX_PACK_BYTES) throw new HttpError(413, 'payload_too_large');
        files.push({ name: part.filename, data });
      }
      const [first] = files;
      if (first === undefined) throw new HttpError(400, 'file_required');
      let pack: ImportPack;
      try {
        pack =
          files.length === 1 && isZip(first.name, first.data)
            ? packFromZip(first.data)
            : packFromFiles(files);
      } catch (err) {
        if (err instanceof PackError) {
          throw new HttpError(422, 'invalid_pack', err.message, { message: err.message });
        }
        throw err;
      }
      const jobId = await enqueue(db, IMPORT_JOB_KIND, { pack }, { userId: ctx.userId });
      await audit(db, 'data.import_queued', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { jobId },
      });
      return reply.code(202).send({ jobId });
    },
  );

  // LinkedIn data export (FR-C2): the user's own export ZIP is the only LinkedIn data path (C-1).
  api.post(
    '/imports/linkedin',
    { schema: { response: { 202: z.object({ jobId: z.string() }) } } },
    async (req, reply) => {
      const ctx = requireUser(req);
      if (!req.isMultipart()) throw new HttpError(415, 'unsupported_media_type');
      let upload: Buffer | undefined;
      let total = 0;
      for await (const part of req.files()) {
        const data = await part.toBuffer();
        total += data.length;
        if (total > MAX_PACK_BYTES) throw new HttpError(413, 'payload_too_large');
        // One file is expected; any further parts count toward the cap and are ignored.
        upload ??= data;
      }
      if (upload === undefined) throw new HttpError(400, 'file_required');
      let pack: LinkedInPack;
      try {
        if (!upload.subarray(0, 4).equals(ZIP_MAGIC)) {
          throw new PackError('upload the LinkedIn data export as the .zip file LinkedIn sent');
        }
        pack = linkedInPackFromZip(upload);
      } catch (err) {
        if (err instanceof PackError) {
          throw new HttpError(422, 'invalid_pack', err.message, { message: err.message });
        }
        throw err;
      }
      const jobId = await enqueue(db, LINKEDIN_IMPORT_JOB_KIND, { pack }, { userId: ctx.userId });
      await audit(db, 'data.linkedin_import_queued', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { jobId },
      });
      return reply.code(202).send({ jobId });
    },
  );

  api.get(
    '/imports/:jobId',
    {
      schema: {
        params: z.object({ jobId: z.string().min(1).max(64) }),
        response: { 200: ImportStatus },
      },
    },
    async (req) => {
      const ctx = requireUser(req);
      const job = await db
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.id, req.params.jobId),
            inArray(jobs.kind, IMPORT_KINDS),
            eq(jobs.userId, ctx.userId),
          ),
        )
        .get();
      if (job === undefined) throw notFound();
      const result = (job.result ?? null) as ImportResult | null;
      return {
        id: job.id,
        status: job.status,
        attempts: job.attempts,
        lastError: job.lastError,
        progress: result?.progress ?? null,
        report: result?.report ?? null,
      };
    },
  );

  api.get('/export', async (req, reply) => {
    const ctx = requireUser(req);
    const now = Date.now();
    const entries = await buildExport(db, ctx, now);
    await audit(db, 'data.export', { userId: ctx.userId, ip: req.ip });
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="opportun-export-${yyyymmdd(now)}.zip"`)
      .header('cache-control', 'private, no-store')
      .send(zipStream(entries));
  });
}
