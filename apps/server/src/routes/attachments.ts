// Opportunity attachments (FR-O8, NFR-SEC11). Uploads stream through @fastify/multipart
// into confined storage; downloads stream back with a sanitized content-disposition.
import { Readable } from 'node:stream';
import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HttpError } from '../lib/errors';
import {
  assertCanAttach,
  createAttachment,
  deleteAttachment,
  getAttachmentForDownload,
  listAttachments,
} from '../repos/attachments';
import { IdParams, listQuery, pageOf } from './common';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const FALLBACK_NAME = 'attachment';
const MAX_NAME = 200;

const AttachmentMetaSchema = z.object({
  id: z.string(),
  userId: z.string(),
  opportunityId: z.string().nullable(),
  filename: z.string(),
  mime: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  createdAt: z.number().int(),
});
const PageQuery = listQuery([]).omit({ sort: true });

const tooLarge = () => new HttpError(413, 'payload_too_large');

/**
 * Passes bytes through and throws 413 once more than `max` have been seen. busboy is
 * capped at max + 1, so an oversize upload always trips this before the stream ends and
 * storage discards its temp file instead of keeping a cut-off copy.
 */
async function* capped(source: AsyncIterable<Buffer>, max: number): AsyncGenerator<Buffer> {
  let seen = 0;
  for await (const chunk of source) {
    seen += chunk.length;
    if (seen > max) throw tooLarge();
    yield chunk;
  }
}

/** Control characters out, length capped: the client's name kept as metadata only. */
export function cleanFilename(raw: string): string {
  const cleaned = raw.replace(/\p{Cc}/gu, '').trim();
  return cleaned.slice(0, 255) || FALLBACK_NAME;
}

/** A type/subtype token or application/octet-stream; parameters and junk are dropped. */
export function cleanMime(raw: string | undefined): string {
  const mime = (raw ?? '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime) && mime.length <= 100
    ? mime
    : 'application/octet-stream';
}

/** Types a browser could execute or render as a document: always served as opaque bytes. */
const ACTIVE_CONTENT =
  /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/javascript|application\/x-javascript|text\/xsl)$/;

export function servedMime(stored: string): string {
  const mime = cleanMime(stored);
  return ACTIVE_CONTENT.test(mime) ? 'application/octet-stream' : mime;
}

/** Last path segment with leading dots removed: never a path, never a hidden file. */
function baseName(name: string): string {
  const last = name.split(/[/\\]/).pop() ?? '';
  const base = last
    .replace(/\p{Cc}/gu, '')
    .replace(/^[.\s]+/, '')
    .trim();
  return base.slice(0, MAX_NAME) || FALLBACK_NAME;
}

/** RFC 5987 value: percent-encode everything outside attr-char. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*!]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Content-Disposition for a stored filename: always `attachment`, an ASCII fallback with
 * every character outside [A-Za-z0-9._ -] replaced, plus the UTF-8 name per RFC 6266.
 */
export function contentDisposition(stored: string): string {
  const base = baseName(stored);
  const ascii = base.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/_+/g, '_') || FALLBACK_NAME;
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(base)}`;
}

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  await app.register(multipart, {
    // Keep the client's full name (including any path) as metadata; it is sanitized on
    // the way out and never used to build a path.
    preservePath: true,
    limits: {
      fileSize: MAX_ATTACHMENT_BYTES + 1,
      files: 1,
      fields: 5,
      fieldSize: 1024,
      parts: 6,
      headerPairs: 20,
    },
  });
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  const storage = app.storage;

  api.post(
    '/opportunities/:id/attachments',
    { schema: { params: IdParams, response: { 201: AttachmentMetaSchema } } },
    async (req, reply) => {
      const ctx = app.requireUser(req);
      await assertCanAttach(db, ctx, req.params.id);
      if (!req.isMultipart()) throw new HttpError(415, 'unsupported_media_type');
      const part = await req.file();
      if (part === undefined) throw new HttpError(400, 'file_required');
      const stored = await storage.writeAttachment(
        Readable.from(capped(part.file, MAX_ATTACHMENT_BYTES)),
      );
      const meta = await createAttachment(db, ctx, req.params.id, {
        filename: cleanFilename(part.filename),
        mime: cleanMime(part.mimetype),
        bytes: stored.bytes,
        sha256: stored.sha256,
        storedPath: stored.storedPath,
      });
      return reply.code(201).send(meta);
    },
  );

  api.get(
    '/opportunities/:id/attachments',
    {
      schema: {
        params: IdParams,
        querystring: PageQuery,
        response: { 200: pageOf(AttachmentMetaSchema) },
      },
    },
    async (req) => listAttachments(db, app.requireUser(req), req.params.id, req.query),
  );

  api.get('/attachments/:id', { schema: { params: IdParams } }, async (req, reply) => {
    const row = await getAttachmentForDownload(db, app.requireUser(req), req.params.id);
    const stream = await storage.openAttachment(row.storedPath);
    return reply
      .header('content-type', servedMime(row.mime))
      .header('content-length', row.bytes)
      .header('content-disposition', contentDisposition(row.filename))
      .header('cache-control', 'private, no-store')
      .send(stream);
  });

  api.delete(
    '/attachments/:id',
    { schema: { params: IdParams, response: { 204: z.null() } } },
    async (req, reply) => {
      await deleteAttachment(db, app.requireUser(req), req.params.id);
      return reply.code(204).send(null);
    },
  );
}
