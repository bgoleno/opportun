// Connector mail ingest (FR-M5, design 6.2 "Apple Mail", ADR-10): the opportun-connector CLI on
// the user's Mac reads Apple Mail locally and pushes normalized messages here with a mail:push
// device token. Bearer only (no session, no CSRF), write only. Every message goes through the
// same ingest as Gmail (mailIngest), so pushed mail is capped, upserted and fenced exactly
// like synced mail: it is hostile input from the classifier's point of view.
import { createHash } from 'node:crypto';
import type { FastifyInstance, onRequestAsyncHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { APPLE_MAIL_INTEGRATION, ingestInbound } from '../jobs/mailIngest';
import { deviceRoute, requireDevice, requireDeviceToken } from '../lib/deviceTokens';
import { HttpError } from '../lib/errors';
import { rateLimit } from '../lib/rateLimit';
import { putSyncState } from '../repos/communications';

const MB = 1024 * 1024;
/** Messages per batch; the connector splits larger syncs. */
export const MAX_BATCH_MESSAGES = 100;
/** One stored message body, in UTF-8 bytes: longer bodies are truncated to fit. */
export const MAX_MESSAGE_BODY_BYTES = MB;
/** One message body as sent, in UTF-8 bytes: beyond this the batch is refused (abuse). */
export const MAX_SENT_BODY_BYTES = 5 * MB;
/** How far ahead of the server clock a sent date may be; later dates are clamped to it. */
export const MAX_SENT_AHEAD_MS = 24 * 60 * 60 * 1000;
/** Appended to a cut body, as the classifier marks its own cut. */
const TRUNCATED_MARK = '\n[truncated]';
/** All bodies of one batch together, in UTF-8 bytes. */
export const MAX_BATCH_BODY_BYTES = 10 * MB;
/** The request itself: the body cap plus room for JSON escaping and headers of 100 messages. */
const ROUTE_BODY_LIMIT = 12 * MB;

/** The adapters/mailProvider InboundMessage shape. Long strings are cut by upsertInbound. */
const InboundMessageSchema = z.object({
  externalId: z.string().min(1).max(1024),
  threadKey: z.string().max(1024),
  from: z.string().max(4096),
  to: z.array(z.string().max(4096)).max(500),
  subject: z.string().max(16_384),
  snippet: z.string().max(16_384),
  bodyText: z.string(),
  sentAt: z.number().int().min(0).max(8_640_000_000_000_000),
});
const BatchBody = z.object({ messages: z.array(InboundMessageSchema) });
/**
 * Batches per token: generous for a first backfill (30 x 100 messages per 15 minutes) but a
 * stolen token cannot flood storage or the AI classifier without bound.
 */
export const BATCH_RATE_LIMIT = { limit: 30, windowMs: 15 * 60 * 1000 };

/** The connector's own prefix on every id it sends. */
const CONNECTOR_ID_PREFIX = 'apple-mail:';
/**
 * What the remainder of a connector id may look like: printable ASCII, no space, and none of
 * `<`, `>` or `"`, which are what a Message-ID is delimited by rather than made of.
 */
const CONNECTOR_ID_BODY = /^[!-~]{1,512}$/;
const CONNECTOR_ID_FORBIDDEN = /["<>]/;

/**
 * The id this message is stored under (Plan 3 Task 3).
 *
 * The id is both the dedupe key and what the deep link is built from, so a malformed one is
 * worth normalizing. It is NOT worth rejecting: the connector re-sends a failed batch, so a
 * strict validator would wedge the sync permanently on one odd message. An id whose remainder
 * is not usable becomes the fallback shape the connector itself uses when Apple Mail has no
 * Message-ID, `apple-mail:sha256:<hex>`, which is stable (the same input gives the same id, so
 * a re-push still dedupes) and which `mailLink` already declines to build a link from.
 */
export function normalizeConnectorId(externalId: string): string {
  const rest = externalId.startsWith(CONNECTOR_ID_PREFIX)
    ? externalId.slice(CONNECTOR_ID_PREFIX.length)
    : externalId;
  if (CONNECTOR_ID_BODY.test(rest) && !CONNECTOR_ID_FORBIDDEN.test(rest)) return externalId;
  const hash = createHash('sha256').update(externalId, 'utf8').digest('hex');
  return CONNECTOR_ID_PREFIX + 'sha256:' + hash;
}

/**
 * The body cut to at most MAX_MESSAGE_BODY_BYTES of UTF-8 (marker included), on a character
 * boundary. A connector cannot know the byte length its characters make, so an overlong body
 * is kept in part rather than wedging its sync on a refusal it would resend forever.
 */
export function capBody(body: string, bytes: number): string {
  if (bytes <= MAX_MESSAGE_BODY_BYTES) return body;
  const buf = Buffer.from(body, 'utf8');
  let end = MAX_MESSAGE_BODY_BYTES - Buffer.byteLength(TRUNCATED_MARK, 'utf8');
  // Never split a multi-byte sequence: back off over continuation bytes (10xxxxxx).
  while (end > 0 && (buf.readUInt8(end) & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8') + TRUNCATED_MARK;
}

const ErrorResponse = z.object({ error: z.object({ code: z.string() }) });

export async function connectorMailRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  // Keyed by the token (set by the device auth hook that runs first), not by IP or user.
  const perToken = rateLimit({ ...BATCH_RATE_LIMIT, keyFn: (req) => requireDevice(req).tokenId });

  api.post(
    '/connector/mail/batch',
    {
      ...deviceRoute('mail:push'),
      // Authenticate and spend the token's budget before the (up to 12MB) body is read, not
      // only in preHandler: neither an anonymous client nor a throttled token gets the server
      // to buffer and parse an upload. The preHandler (deviceRoute) authenticates again.
      onRequest: [
        requireDeviceToken('mail:push') as unknown as onRequestAsyncHookHandler,
        perToken as unknown as onRequestAsyncHookHandler,
      ],
      bodyLimit: ROUTE_BODY_LIMIT,
      schema: {
        body: BatchBody,
        response: {
          200: z.object({ stored: z.number().int(), inserted: z.number().int() }),
          413: ErrorResponse,
          429: ErrorResponse,
          422: ErrorResponse,
        },
      },
    },
    async (req) => {
      const ctx = requireDevice(req);
      const { messages } = req.body;
      if (messages.length > MAX_BATCH_MESSAGES) throw new HttpError(422, 'too_many_messages');
      let total = 0;
      // A bogus far-future date would pin a message to the top of every list: clamp it.
      const latest = Date.now() + MAX_SENT_AHEAD_MS;
      const capped = messages.map((m) => {
        const bytes = Buffer.byteLength(m.bodyText, 'utf8');
        if (bytes > MAX_SENT_BODY_BYTES) throw new HttpError(413, 'message_too_large');
        total += bytes;
        return {
          ...m,
          externalId: normalizeConnectorId(m.externalId),
          bodyText: capBody(m.bodyText, bytes),
          sentAt: Math.min(m.sentAt, latest),
        };
      });
      if (total > MAX_BATCH_BODY_BYTES) throw new HttpError(413, 'batch_too_large');

      let stored = 0;
      let inserted = 0;
      try {
        for (const message of capped) {
          const res = await ingestInbound(db, ctx, app.storage, 'apple_mail', message);
          stored += 1;
          if (res.inserted) inserted += 1;
        }
      } catch (err) {
        // Whatever was stored stays; a re-push of the batch upserts it.
        await putSyncState(db, ctx, APPLE_MAIL_INTEGRATION, { status: 'error' });
        throw err;
      }
      // The connector keeps its own cursor; the server only records that a batch landed.
      await putSyncState(db, ctx, APPLE_MAIL_INTEGRATION, {
        lastSyncAt: Date.now(),
        status: 'ok',
      });
      return { stored, inserted };
    },
  );
}
