// The browser extension's read routes for assisted apply prefill (M3b,
// https://github.com/bgoleno/opportun/issues/182; design Part A 6.2, tl's rulings on the issue).
// Bearer `apply:assist` device token only, no session and no CSRF. Each answers about one
// attempt: the caller's handed-off application whose pinned destination is the page the
// extension is on, and that attempt's resume snapshot. Nothing here starts, reviews, hands off or
// submits anything, and nothing lists applications.
//
// Off, or on the demo, every route here 404s before any token is looked at, whatever the token's
// scopes (sec on #182).
import {
  ATS_REF_KINDS,
  SUBMISSION_SNAPSHOT_STATES,
  SubmissionAnswersSchema,
  SubmissionFieldsSchema,
} from '@opportun/core';
import type { FastifyInstance, onRequestAsyncHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { submissionsEnabled } from '../config';
import { audit } from '../lib/audit';
import { deviceRoute, requireDevice, requireDeviceToken } from '../lib/deviceTokens';
import { HttpError } from '../lib/errors';
import { rateLimit } from '../lib/rateLimit';
import { handedOffForPage, handedOffSnapshot } from '../repos/submissions';
import { contentDisposition } from './attachments';

/** The full path, for the request log's query redaction (app.ts): the page URL is not logged. */
export const CONNECTOR_APPLY_CURRENT_PATH = '/api/v1/connector/apply/current';

const CurrentQuery = z
  .object({
    /** The page the extension is on, the attempt's destination if it is the right one. */
    url: z.string().min(1).max(2048),
  })
  .strict();

const CurrentResponse = z.object({
  attempt: z
    .object({
      id: z.string(),
      opportunityId: z.string(),
      opportunityTitle: z.string(),
      companyName: z.string(),
      atsKind: z.enum(ATS_REF_KINDS),
      destinationUrl: z.string(),
      /** What the user reviewed: the digest covers these. */
      fields: SubmissionFieldsSchema,
      answers: SubmissionAnswersSchema,
      resume: z.object({
        title: z.string().nullable(),
        snapshotState: z.enum(SUBMISSION_SNAPSHOT_STATES).nullable(),
        /** Set only when the snapshot is ready to attach. */
        filename: z.string().nullable(),
        bytes: z.number().int().nullable(),
      }),
    })
    .nullable(),
  /** Why there is no attempt for this page; null when there is one. */
  reason: z.enum(['no_matching_attempt', 'several_handed_off', 'review_stale']).nullable(),
});

const IdParams = z.object({ id: z.string().min(1).max(64) }).strict();

/** The page's host for the audit entry: the full URL is not recorded (tl on #182). */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export async function connectorApplyRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  app.addHook('onRequest', async () => {
    if (!submissionsEnabled(app.config)) throw new HttpError(404, 'feature_unavailable');
  });

  // Reads, keyed by the token the auth hook resolved; generous for a popup's few calls per
  // application, low enough that a leaked token cannot be used to sweep.
  const perToken = rateLimit({
    limit: 60,
    windowMs: 15 * 60 * 1000,
    keyFn: (req) => requireDevice(req).tokenId,
  });
  const authenticate = [
    requireDeviceToken('apply:assist') as unknown as onRequestAsyncHookHandler,
    perToken as unknown as onRequestAsyncHookHandler,
  ];

  api.get(
    '/connector/apply/current',
    {
      ...deviceRoute('apply:assist'),
      onRequest: authenticate,
      schema: { querystring: CurrentQuery, response: { 200: CurrentResponse } },
    },
    async (req) => {
      const ctx = requireDevice(req);
      const found = await handedOffForPage(db, ctx, req.query.url);
      await audit(db, 'submission.prefill_read', {
        userId: ctx.userId,
        ip: req.ip,
        detail: {
          tokenId: ctx.tokenId,
          host: hostOf(req.query.url),
          ...(found.kind === 'found'
            ? { submissionId: found.row.id }
            : { submissionId: null, reason: found.reason }),
        },
      });
      if (found.kind === 'none') return { attempt: null, reason: found.reason };
      const { row } = found;
      return {
        attempt: {
          id: row.id,
          opportunityId: row.opportunityId,
          opportunityTitle: found.opportunityTitle,
          companyName: found.companyName,
          atsKind: row.atsKind,
          destinationUrl: row.destinationUrl,
          fields: row.fields,
          answers: row.answers,
          resume: {
            title: row.resumeTitle,
            snapshotState: row.snapshotState,
            filename: found.snapshotFile?.filename ?? null,
            bytes: found.snapshotFile?.bytes ?? null,
          },
        },
        reason: null,
      };
    },
  );

  // The id is the one /current returned, so a second handoff between the two calls cannot swap
  // the file under the filler (tl on #182). Streamed as the session download is.
  api.get(
    '/connector/apply/:id/snapshot',
    { ...deviceRoute('apply:assist'), onRequest: authenticate, schema: { params: IdParams } },
    async (req, reply) => {
      const ctx = requireDevice(req);
      const { row, file } = await handedOffSnapshot(db, ctx, req.params.id);
      await audit(db, 'submission.snapshot_downloaded', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { submissionId: row.id, tokenId: ctx.tokenId, via: 'device' },
      });
      const stream = await app.storage.openAttachment(file.storedPath);
      return reply
        .header('content-type', 'application/pdf')
        .header('content-length', file.bytes)
        .header('content-disposition', contentDisposition(file.filename))
        .header('cache-control', 'private, no-store')
        .send(stream);
    },
  );
}
