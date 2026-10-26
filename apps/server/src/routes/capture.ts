// Manual capture (FR-D1 manual source). The user hands over a job posting as a URL or as pasted
// text; capture.extract turns it into posting fields, and the posting enters the review queue
// as a pending result of the user's synthetic manual source (sanitized, deduplicated and ranked
// like any discovered posting). Nothing becomes an opportunity until the user accepts it.
//
// URL path: fetched with safeFetch in allowPublic mode (https, public addresses on every hop).
// Prohibited hosts (LinkedIn) are refused up front with a 422 naming the compliant path: paste
// the description text instead. Text path: no fetch at all.
// AI unavailable: 503, and the UI falls back to the New Opportunity dialog (manual entry).
//
// With a resultId, the capture completes one of the user's own partial leads (a pending
// needs_capture result) in place: the extracted description fills that lead, which becomes
// 'full' and is ranked again. No second result is stored, so the lead is never flagged
// multi-posted against itself.
import { AiUnavailableError, CaptureOutputSchema, renderPrompt, runStructured } from '@opportun/ai';
import { NormalizedPostingSchema, type NormalizedPosting } from '@opportun/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { withTransaction, type Db } from '../db/client';
import { DISCOVERY_RANK_KIND } from '../jobs/discoveryKinds';
import { insertLeads } from '../jobs/discoveryRun';
import { enqueue } from '../jobs/runner';
import { buildAiDeps, expiredKeyHint } from '../lib/ai';
import { HttpError } from '../lib/errors';
import { sanitizeDescriptionText, sanitizePosting } from '../lib/postingSanitize';
import { FetchBlockedError, isProhibitedHost, type safeFetch } from '../lib/safeFetch';
import type { UserCtx } from '../repos/base';
import {
  ensureChannelSource,
  getResult,
  setResolution,
  type DiscoveryResultView,
} from '../repos/discovery';
import { getActivePrompt } from '../repos/prompts';
import { HttpsUrl } from './common';
import type { Exec as AsyncExec } from '../db/client';

/** Characters of page or pasted text the model sees. */
export const CAPTURE_MAX_TEXT = 50_000;
const PAGE_MAX_BYTES = 3 * 1024 * 1024;

export const PASTE_TEXT_HINT =
  'This site cannot be fetched. Open the posting in your browser and paste the description text instead.';
const MANUAL_HINT =
  'AI extraction is unavailable. Add the posting with New Opportunity (manual entry) instead.';

const CaptureBody = z
  .object({
    url: HttpsUrl.optional(),
    text: z.string().trim().min(1).max(200_000).optional(),
    /** A pending needs_capture result of the caller's to complete in place. */
    resultId: z.string().min(1).max(64).optional(),
  })
  .strict()
  .refine((b) => (b.url === undefined) !== (b.text === undefined), {
    message: 'send exactly one of url or text',
  });

const CaptureResponse = z.object({
  posting: NormalizedPostingSchema,
  resultId: z.string(),
});

type CaptureOutput = z.infer<typeof CaptureOutputSchema>;

export async function fetchPageText(fetch: typeof safeFetch, url: string): Promise<string> {
  if (isProhibitedHost(new URL(url).hostname)) {
    throw new HttpError(422, 'prohibited_host', undefined, { hint: PASTE_TEXT_HINT });
  }
  let res;
  try {
    res = await fetch(url, { allowHosts: [], allowPublic: true, maxBytes: PAGE_MAX_BYTES });
  } catch (err) {
    if (err instanceof FetchBlockedError) {
      // A redirect to a prohibited host lands here too: same compliant path.
      throw new HttpError(422, 'fetch_blocked', undefined, {
        reason: err.reason,
        hint: PASTE_TEXT_HINT,
      });
    }
    throw new HttpError(422, 'fetch_failed', undefined, { hint: PASTE_TEXT_HINT });
  }
  if (res.status < 200 || res.status >= 300) {
    throw new HttpError(422, 'fetch_failed', undefined, {
      status: res.status,
      hint: PASTE_TEXT_HINT,
    });
  }
  const body = res.body.toString('utf8');
  const type = res.headers.get('content-type') ?? '';
  // A plain-text body is used as-is (insertLeads/resolveLeadInPlace sanitize it before storage
  // either way); an HTML body is cleaned here with the same parser sanitizePosting uses, not the
  // Gmail adapter's htmlToText (issue #238: htmlToText's <head> handling mishandles a script tag
  // whose JSON values are themselves complete HTML documents, the exact shape of an ATS page's
  // i18n bundle, and the corruption happens before sanitizePosting ever runs). keepLinks is not
  // needed here: postingUrl always comes from the request's own `url`, never from extracted text.
  if (!(/html/i.test(type) || /^\s*</.test(body))) return body;
  const cleaned = sanitizeDescriptionText(body);
  if (cleaned === null) {
    throw new HttpError(422, 'fetch_unreadable', undefined, { hint: PASTE_TEXT_HINT });
  }
  return cleaned;
}

export async function extract(
  db: Db,
  ctx: UserCtx,
  url: string | undefined,
  text: string,
): Promise<CaptureOutput> {
  const prompt = await getActivePrompt(db, ctx, 'capture.extract');
  if (prompt === undefined) {
    throw new HttpError(503, 'ai_unavailable', undefined, {
      reason: 'no_prompt',
      hint: MANUAL_HINT,
    });
  }
  const page =
    text.length > CAPTURE_MAX_TEXT ? `${text.slice(0, CAPTURE_MAX_TEXT)}\n[truncated]` : text;
  try {
    return await runStructured(await buildAiDeps(db, ctx), 'capture.extract', {
      system: renderPrompt(prompt.body, {
        page_url_untrusted: url ?? '(pasted text: no URL)',
        page_untrusted: page,
      }),
      prompt: 'Extract the job posting and return the result.',
      schema: CaptureOutputSchema,
      promptId: prompt.id,
    });
  } catch (err) {
    if (err instanceof AiUnavailableError) {
      const keyHint = await expiredKeyHint(db, ctx, 'capture.extract', err);
      throw new HttpError(503, 'ai_unavailable', undefined, {
        reason: err.reason,
        hint: keyHint === undefined ? MANUAL_HINT : `${MANUAL_HINT} (${keyHint})`,
        ...(keyHint === undefined ? {} : { keyHint }),
      });
    }
    throw err;
  }
}

/** The extraction as a raw posting (the insert path sanitizes it). */
function toPosting(out: CaptureOutput, url: string | undefined, text: string): NormalizedPosting {
  const company = out.companyName?.trim() ?? '';
  const title = out.title?.trim() ?? '';
  if (company === '' || title === '') {
    throw new HttpError(422, 'extraction_incomplete', undefined, { hint: MANUAL_HINT });
  }
  return {
    company,
    title,
    location: out.location,
    remote: out.remote === null ? null : out.remote === 'remote',
    compNote: out.compNote,
    // Without an extracted description the captured text itself is the description.
    descriptionMd: out.descriptionMd ?? text.slice(0, CAPTURE_MAX_TEXT),
    postingUrl: url ?? out.postingUrl,
  };
}

/** The caller's lead a capture may complete: pending and still needs_capture. 404 / 409. */
async function capturableLead(
  exec: AsyncExec,
  ctx: UserCtx,
  resultId: string,
): Promise<DiscoveryResultView> {
  const lead = await getResult(exec, ctx, resultId);
  if (lead.disposition !== 'pending' || lead.resolution !== 'needs_capture') {
    throw new HttpError(409, 'not_capturable', 'That result no longer needs a capture.');
  }
  return lead;
}

/**
 * Fills a partial lead from a captured posting. The lead keeps its own identity (company,
 * title, so its dedupe key) and any field it already had; the capture supplies the
 * description and whatever else the lead lacked.
 */
async function resolveLeadInPlace(
  db: Db,
  ctx: UserCtx,
  resultId: string,
  raw: NormalizedPosting,
): Promise<DiscoveryResultView> {
  const parsed = NormalizedPostingSchema.safeParse(sanitizePosting(raw));
  if (!parsed.success || parsed.data.descriptionMd == null || parsed.data.descriptionMd === '') {
    throw new HttpError(422, 'invalid_posting');
  }
  const captured = parsed.data;
  const updated = await withTransaction(db, async (tx) => {
    // Re-checked here: the lead may have been accepted or resolved while the AI ran.
    const lead = (await capturableLead(tx, ctx, resultId)).posting;
    return await setResolution(tx, ctx, resultId, {
      resolution: 'full',
      resolvedSourceRef: captured.postingUrl ?? null,
      posting: {
        ...lead,
        descriptionMd: captured.descriptionMd,
        postingUrl: lead.postingUrl ?? captured.postingUrl ?? null,
        location: lead.location ?? captured.location ?? null,
        remote: lead.remote ?? captured.remote ?? null,
        compNote: lead.compNote ?? captured.compNote ?? null,
      },
    });
  });
  await enqueue(
    db,
    DISCOVERY_RANK_KIND,
    { resultId },
    { dedupeKey: `${DISCOVERY_RANK_KIND}:${resultId}`, userId: ctx.userId },
  );
  return updated;
}

export async function captureRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;

  api.post(
    '/capture',
    { schema: { body: CaptureBody, response: { 200: CaptureResponse, 201: CaptureResponse } } },
    async (req, reply) => {
      const ctx = app.requireUser(req);
      const { url, resultId } = req.body;
      // Checked before any fetch or AI call, so a bad resultId costs nothing.
      if (resultId !== undefined) await capturableLead(db, ctx, resultId);
      const text =
        req.body.text ?? (await fetchPageText(app.jobs.services.sourceFetch, url as string));
      const posting = toPosting(await extract(db, ctx, url, text), url, text);
      if (resultId !== undefined) {
        const resolved = await resolveLeadInPlace(db, ctx, resultId, posting);
        return reply.code(200).send({ posting: resolved.posting, resultId: resolved.id });
      }
      const source = await ensureChannelSource(db, ctx, 'manual');
      const { stats, inserted } = await insertLeads(db, ctx, [posting], source.id);
      const result = inserted[0];
      if (result === undefined) {
        throw new HttpError(
          stats.duplicates > 0 ? 409 : 422,
          stats.duplicates > 0 ? 'duplicate' : 'invalid_posting',
        );
      }
      return reply.code(201).send({ posting: result.posting, resultId: result.id });
    },
  );
}
