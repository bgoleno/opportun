// Tailoring sessions and match scoring (FR-R4, R5, R8, FR-A6). The chat streams over SSE and
// only ever talks; edits reach the document solely through the explicit apply endpoint (C-4).
import {
  AiUnavailableError,
  MatchReportSchema,
  renderPrompt,
  runStructured,
  streamChat,
  type CoreMessage,
  type TaskKey,
} from '@opportun/ai';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { MAX_EDITS, RESUME_EDIT_OUTCOMES, ResumeEditSchema } from '../adapters/documentStore';
import { buildAiDeps, expiredKeyHint } from '../lib/ai';
import { audit } from '../lib/audit';
import { HttpError } from '../lib/errors';
import { SECURITY_HEADERS } from '../plugins/security';
import { requireUser, type Db, type UserCtx } from '../repos/base';
import { getOpportunity, type OpportunityView } from '../repos/opportunities';
import { getMatchReport, isMatchStale, putMatchReport } from '../repos/matchReports';
import { getActivePrompt } from '../repos/prompts';
import { getResume, setResumeStatus, updateResumeDocRef, type ResumeRow } from '../repos/resumes';
import {
  activeResumeRules,
  addTaskRunId,
  appendTurn,
  completeSession,
  getSession,
  openSession,
  parseSuggestions,
  replaceTurn,
  type SessionRow,
  type TranscriptTurn,
} from '../repos/tailoring';
import { IdParams } from './common';
import { storeFor } from './resumes';

export { MatchReportSchema };

/** How often a streaming reply is written back to the transcript. */
const FLUSH_INTERVAL_MS = 750;

const EditView = z.object({
  find: z.string(),
  replace: z.string(),
  rationale: z.string().optional(),
});
const MessageView = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  at: z.number().int(),
  edits: z.array(EditView),
  incomplete: z.boolean(),
});
const SessionView = z.object({
  id: z.string(),
  resumeId: z.string(),
  acceptedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  messages: z.array(MessageView),
});

/** A turn as clients see it: an assistant reply's json block becomes `edits`. */
function toMessageView(t: TranscriptTurn): z.infer<typeof MessageView> {
  const content = t.role === 'assistant' ? parseSuggestions(t.content).prose : t.content;
  return {
    role: t.role,
    content,
    at: t.at,
    edits: t.edits ?? [],
    incomplete: t.incomplete === true,
  };
}

function toSessionView(s: SessionRow): z.infer<typeof SessionView> {
  return {
    id: s.id,
    resumeId: s.resumeId,
    acceptedAt: s.acceptedAt,
    createdAt: s.createdAt,
    messages: s.transcript.map(toMessageView),
  };
}

/** The 503 for an AI failure; a provider_error on an expired stored key carries keyHint. */
async function aiUnavailable(
  db: Db,
  ctx: UserCtx,
  task: TaskKey,
  err: AiUnavailableError,
): Promise<HttpError> {
  const keyHint = await expiredKeyHint(db, ctx, task, err);
  return new HttpError(503, 'ai_unavailable', undefined, {
    reason: err.reason,
    ...(keyHint === undefined ? {} : { keyHint }),
  });
}

/** The active prompt body for a task; a missing seed is a server fault, reported as 503. */
async function activePrompt(
  db: Db,
  ctx: UserCtx,
  task: TaskKey,
): Promise<{ body: string; id: string }> {
  const prompt = await getActivePrompt(db, ctx, task);
  if (prompt === undefined)
    throw new HttpError(503, 'ai_unavailable', undefined, { reason: 'no_prompt' });
  return { body: prompt.body, id: prompt.id };
}

/** The job description as the model sees it (rendered into an untrusted fence). */
function jobDescription(opp: OpportunityView | null): string {
  if (opp === null) return 'No job description is linked to this resume.';
  return `${opp.title} at ${opp.companyName}\n\n${opp.descriptionMd ?? '(no description recorded)'}`;
}

function renderRules(rules: string[]): string {
  if (rules.length === 0) return '(The user has no resume rules.)';
  return `## The user's resume rules\n${rules.map((r) => `- ${r}`).join('\n')}`;
}

/**
 * The match score as the model sees it (issue #303). An optional input, same as the job
 * description: no linked opportunity, or one never scored, renders a plain sentence saying so
 * rather than silently omitting the section (jobDescription's own pattern).
 *
 * Staleness is rendered, not just the score, and this is the part that matters: isMatchStale
 * (repos/matchReports.ts, issue #175) exists because a report describes the resume as it stood
 * when scored, and a tailoring session completing afterwards may have changed it since. In the
 * edit-then-rerun-then-review loop this prompt serves, a stale score is the normal mid-loop
 * state, not an edge case -- handing the agent a stale score without saying so would have it
 * reason confidently about a resume version that no longer exists, which is worse than handing
 * it no score at all.
 */
async function matchReportContext(db: Db, ctx: UserCtx, resume: ResumeRow): Promise<string> {
  if (resume.opportunityId === null) {
    return 'No job is linked to this resume, so there is no match score.';
  }
  const row = await getMatchReport(db, ctx, resume.id, resume.opportunityId);
  if (row === undefined) {
    return 'No match score has been run yet for this resume against this job.';
  }
  const stale = await isMatchStale(db, ctx, resume.id, row.scoredAt);
  // Wording matches MatchPanel.tsx's own staleness sentence (issue #304 shows the same report
  // elsewhere): a human reading that banner already knows to re-check; a model needs the
  // explicit instruction added here, since it cannot infer "so go re-run it" from a UI cue.
  const status = stale
    ? 'A tailoring session has completed since, so this may no longer reflect the current ' +
      'document. Treat it as a starting point, not a current fact, and suggest the user ' +
      're-run the match score before relying on it.'
    : 'No tailoring session has completed for this resume since.';
  const { report } = row;
  const missing =
    report.missingKeywords.length === 0 ? '(none)' : report.missingKeywords.join(', ');
  const weakAreas =
    report.weakAreas.length === 0
      ? '(none)'
      : report.weakAreas.map((w) => `- ${w.area}: ${w.suggestion}`).join('\n');
  return `Scored ${new Date(row.scoredAt).toISOString()}. ${status}

Score: ${report.score}/100
Missing keywords: ${missing}
Weak areas:
${weakAreas}
Summary: ${report.summary}`;
}

/**
 * The resume.tailor system prompt: the active prompt version with the user's active rules
 * (read now, not cached), the resume's current text, the job description, and the match
 * score (issue #303). Runs once per turn (the per-message handler calls this fresh, not once
 * per session), so a resume edit, a rules change, or a re-run match score is picked up on the
 * very next message with no session restart.
 */
async function tailorSystem(
  app: FastifyInstance,
  ctx: UserCtx,
  resume: ResumeRow,
): Promise<{ system: string; promptId: string }> {
  const prompt = await activePrompt(app.db, ctx, 'resume.tailor');
  const rules = renderRules(await activeResumeRules(app.db, ctx));
  const opp =
    resume.opportunityId === null ? null : await getOpportunity(app.db, ctx, resume.opportunityId);
  const baseResume = await storeFor(app, resume.store).readText(ctx, resume.docRef);
  const matchReport = await matchReportContext(app.db, ctx, resume);
  const rendered = renderPrompt(prompt.body, {
    resume_rules: rules,
    base_resume: baseResume,
    jd_untrusted: jobDescription(opp),
    match_report: matchReport,
  });
  // A user-edited prompt may drop either placeholder; both are prepended regardless.
  let system = rendered;
  if (!/\{\{\s*match_report\s*\}\}/.test(prompt.body)) system = `${matchReport}\n\n${system}`;
  if (!/\{\{\s*resume_rules\s*\}\}/.test(prompt.body)) system = `${rules}\n\n${system}`;
  return { system, promptId: prompt.id };
}

/** Model context: completed turns only (a cut-off reply is shown to the user, not the model). */
function toModelMessages(transcript: TranscriptTurn[]): CoreMessage[] {
  return transcript
    .filter((t) => !(t.role === 'assistant' && t.incomplete === true))
    .map((t) => ({ role: t.role, content: t.content }));
}

function openSse(reply: FastifyReply): (event: Record<string, unknown>) => void {
  reply.hijack();
  reply.raw.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
  });
  return (event) => {
    if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };
}

const MessageBody = z.object({ content: z.string().trim().min(1).max(20_000) });
const ApplyBody = z.object({ edits: z.array(ResumeEditSchema).min(1).max(MAX_EDITS) });
const MatchBody = z.object({ opportunityId: z.string().min(1).max(64) });
const MatchQuery = z.object({ opportunityId: z.string().min(1).max(64) });
/**
 * A score on its own, with no date, invites exactly the trust the data cannot support: the
 * resume may have changed since. scoredAt and stale (issue #175) are what let a client say
 * "as of" instead of implying the score still describes today's document.
 */
const MatchReportView = z.object({
  report: MatchReportSchema,
  scoredAt: z.number().int(),
  stale: z.boolean(),
});
/**
 * Per-edit, not an aggregate count (issue #146): "applied" tells a person a specific change
 * landed, "already_consumed" tells them a specific change did not, because an earlier edit in
 * the same request already replaced every occurrence of its find text. A single number cannot
 * say which edit that was.
 */
const ApplyResultSchema = z.object({
  results: z.array(z.object({ index: z.number().int(), outcome: z.enum(RESUME_EDIT_OUTCOMES) })),
});

export async function tailoringRoutes(app: FastifyInstance): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  /** Sessions with a reply streaming now: one at a time keeps the transcript ordered. */
  const streaming = new Set<string>();

  api.post(
    '/resumes/:id/tailoring',
    { schema: { params: IdParams, response: { 200: SessionView } } },
    async (req) => toSessionView(await openSession(db, requireUser(req), req.params.id)),
  );

  api.get(
    '/tailoring/:id',
    { schema: { params: IdParams, response: { 200: SessionView } } },
    async (req) => toSessionView(await getSession(db, requireUser(req), req.params.id)),
  );

  api.post(
    '/tailoring/:id/messages',
    { schema: { params: IdParams, body: MessageBody } },
    async (req, reply) => {
      const ctx = requireUser(req);
      const sessionId = req.params.id;
      const session = await getSession(db, ctx, sessionId);
      if (session.acceptedAt !== null) throw new HttpError(409, 'session_closed');
      if (streaming.has(sessionId)) throw new HttpError(409, 'reply_in_progress');
      streaming.add(sessionId);
      try {
        // Persisted before anything that can fail, so a failed call never loses it.
        const userTurn: TranscriptTurn = {
          role: 'user',
          content: req.body.content,
          at: Date.now(),
        };
        await appendTurn(db, ctx, sessionId, userTurn);

        const resume = await getResume(db, ctx, session.resumeId);
        const { system, promptId } = await tailorSystem(app, ctx, resume);
        const messages = toModelMessages((await getSession(db, ctx, sessionId)).transcript);
        const deps = await buildAiDeps(db, ctx, {
          onRecorded: async (runId) => await addTaskRunId(db, ctx, sessionId, runId),
        });
        let result;
        try {
          result = await streamChat(deps, 'resume.tailor', { system, messages, promptId });
        } catch (err) {
          if (err instanceof AiUnavailableError) {
            throw await aiUnavailable(db, ctx, 'resume.tailor', err);
          }
          throw err;
        }

        const send = openSse(reply);
        send({ type: 'start', message: toMessageView(userTurn) });
        let text = '';
        let index: number | undefined;
        let lastFlush = 0;
        const at = Date.now();
        const persist = async (
          incomplete: boolean,
          edits?: TranscriptTurn['edits'],
        ): Promise<TranscriptTurn> => {
          const turn: TranscriptTurn = {
            role: 'assistant',
            content: text,
            at,
            ...(edits === undefined ? {} : { edits }),
            ...(incomplete ? { incomplete: true } : {}),
          };
          if (index === undefined) index = await appendTurn(db, ctx, sessionId, turn);
          else await replaceTurn(db, ctx, sessionId, index, turn);
          lastFlush = Date.now();
          return turn;
        };
        try {
          for await (const part of result.stream) {
            if (part.type === 'text-delta') {
              text += part.text;
              send({ type: 'delta', text: part.text });
              if (Date.now() - lastFlush >= FLUSH_INTERVAL_MS) await persist(true);
            } else if (part.type === 'error') {
              throw part.error;
            } else if (part.type === 'abort') {
              throw new Error('aborted');
            }
          }
          const turn = await persist(false, parseSuggestions(text).edits);
          send({ type: 'done', message: toMessageView(turn) });
        } catch {
          // The provider error text stays server-side (the router records a sanitized copy).
          if (text.length > 0) await persist(true);
          const keyHint = await expiredKeyHint(
            db,
            ctx,
            'resume.tailor',
            new AiUnavailableError('provider_error'),
          ).catch(() => undefined);
          send({
            type: 'error',
            code: 'ai_unavailable',
            reason: 'provider_error',
            ...(keyHint === undefined ? {} : { keyHint }),
          });
        } finally {
          reply.raw.end();
        }
      } finally {
        streaming.delete(sessionId);
      }
    },
  );

  api.post(
    '/tailoring/:id/suggestions/apply',
    {
      schema: {
        params: IdParams,
        body: ApplyBody,
        response: { 200: ApplyResultSchema },
      },
    },
    async (req) => {
      const ctx = requireUser(req);
      // Both lookups are user-scoped: another user's session or resume is a 404.
      const session = await getSession(db, ctx, req.params.id);
      const resume = await getResume(db, ctx, session.resumeId);
      const edits = req.body.edits.map(({ find, replace }) => ({ find, replace }));
      const { docRef, results } = await storeFor(app, resume.store).applyEdits(
        ctx,
        resume.docRef,
        edits,
      );
      // Unchanged for a store that mutates its document in place; a new ref for one whose
      // written content is immutable per version (local_file, #284), which the store itself
      // never writes to this row (ResumeEditOutcomeResult's own doc comment).
      if (docRef !== resume.docRef) await updateResumeDocRef(db, ctx, resume.id, docRef);
      const appliedCount = results.filter((r) => r.outcome === 'applied').length;
      await audit(db, 'resume.edits_applied', {
        userId: ctx.userId,
        ip: req.ip,
        detail: { resumeId: resume.id, sessionId: session.id, count: edits.length, appliedCount },
      });
      return { results };
    },
  );

  api.post(
    '/tailoring/:id/complete',
    { schema: { params: IdParams, response: { 200: SessionView } } },
    async (req) => {
      const ctx = requireUser(req);
      const session = await completeSession(db, ctx, req.params.id);
      await setResumeStatus(db, ctx, session.resumeId, 'in_review');
      return toSessionView(session);
    },
  );

  api.get(
    '/resumes/:id/match',
    {
      schema: {
        params: IdParams,
        querystring: MatchQuery,
        response: { 200: MatchReportView.nullable() },
      },
    },
    async (req) => {
      const ctx = requireUser(req);
      await getResume(db, ctx, req.params.id);
      const row = await getMatchReport(db, ctx, req.params.id, req.query.opportunityId);
      if (row === undefined) return null;
      return {
        report: row.report,
        scoredAt: row.scoredAt,
        stale: await isMatchStale(db, ctx, req.params.id, row.scoredAt),
      };
    },
  );

  api.post(
    '/resumes/:id/match',
    { schema: { params: IdParams, body: MatchBody, response: { 200: MatchReportView } } },
    async (req) => {
      const ctx = requireUser(req);
      const resume = await getResume(db, ctx, req.params.id);
      const opp = await getOpportunity(db, ctx, req.body.opportunityId);
      const prompt = await activePrompt(db, ctx, 'resume.match');
      const resumeText = await storeFor(app, resume.store).readText(ctx, resume.docRef);
      const system = renderPrompt(prompt.body, {
        resume_text: resumeText,
        jd_untrusted: jobDescription(opp),
      });
      let report;
      try {
        report = await runStructured(await buildAiDeps(db, ctx), 'resume.match', {
          system,
          prompt: 'Assess how well the resume matches the job description and return the report.',
          schema: MatchReportSchema,
          promptId: prompt.id,
        });
      } catch (err) {
        if (err instanceof AiUnavailableError) {
          throw await aiUnavailable(db, ctx, 'resume.match', err);
        }
        throw err;
      }
      const scoredAt = await putMatchReport(db, ctx, resume.id, opp.id, report);
      return { report, scoredAt, stale: false };
    },
  );
}
