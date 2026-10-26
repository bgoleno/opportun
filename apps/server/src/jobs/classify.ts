// comms.classify job (FR-M2, M3, M8). Renders the comms.classify prompt with the message as
// untrusted data, the user's role targets and the opportunities they track, runs the structured
// task, then hands the output to the deterministic post-processing in repos/communications.
// Job alert digests (Task 12) never reach the model: they are routed to the alert-email lead
// parser instead (normally at sync time; here too, for backfills and retries).
import { buffer } from 'node:stream/consumers';
import {
  AiUnavailableError,
  ClassifyOutputSchema as AiClassifyOutputSchema,
  renderPrompt,
  runStructured,
} from '@opportun/ai';
import { seniorityRangeText, type BodySource } from '@opportun/core';
import { and, desc, eq, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { isAlertDigest, processAlertDigest } from '../adapters/sources/alertEmail';
import type { Db } from '../db/client';
import { communications, companies, opportunities, roleTargets } from '../db/schema';
import { buildAiDeps } from '../lib/ai';
import { line } from '../lib/promptText';
import type { Storage } from '../lib/storage';
import type { UserCtx } from '../repos/base';
import { applyClassification, type ApplyOutcome } from '../repos/communications';
import { getActivePrompt } from '../repos/prompts';
import { enqueueEnrich } from './opportunityEnrich';
import { CLASSIFY_JOB_KIND } from './gmailSync';
import { requireService, type JobHandler } from './registry';

/**
 * The classifier's structured output (Task 33 contract): classification, outreachKind (null
 * when not recruiter outreach), mismatchReason (set for irrelevant outreach), opportunityMatch,
 * proposedTransition and confidence in [0, 1]. Defined once in @opportun/ai, where the router
 * validates provider output against it.
 */
export const ClassifyOutputSchema = AiClassifyOutputSchema;
export type ClassifyOutput = z.infer<typeof ClassifyOutputSchema>;

const MAX_BODY_CHARS = 20_000;
const MAX_OPEN_OPPORTUNITIES = 200;

/** One role target as a line of prompt context (the user's own data, line()-sanitized). */
export function roleTargetLine(t: typeof roleTargets.$inferSelect): string {
  const parts = [`${line(t.name)}: ${line(t.titleFamily)}`];
  // Ordinals are rendered as ladder names so the model reads them the way the user chose them.
  parts.push(`seniority ${seniorityRangeText(t.seniorityMin, t.seniorityMax)}`);
  if (t.keywords.length > 0) {
    parts.push(`keywords ${t.keywords.map((k) => line(k, 60)).join(', ')}`);
  }
  if (t.industries.length > 0) {
    parts.push(`industries ${t.industries.map((k) => line(k, 60)).join(', ')}`);
  }
  if (t.locations.length > 0) {
    parts.push(`locations ${t.locations.map((k) => line(k, 60)).join(', ')}`);
  }
  parts.push(`remote preference ${t.remotePref}`);
  if (t.compMin !== null || t.compMax !== null) {
    parts.push(
      `compensation ${t.compMin ?? '?'} to ${t.compMax ?? '?'} ${t.currency ?? ''}`.trim(),
    );
  }
  return `- ${parts.join('; ')}`;
}

export async function roleTargetsText(db: Db, ctx: UserCtx): Promise<string> {
  const rows = await db
    .select()
    .from(roleTargets)
    .where(and(eq(roleTargets.userId, ctx.userId), eq(roleTargets.active, true)))
    .all();
  if (rows.length === 0) {
    return 'No role targets are set. Treat any specific, plausible role as relevant.';
  }
  return rows.map(roleTargetLine).join('\n');
}

/**
 * Tracked opportunities that are still open (company, title, stage), newest first. Rendered as
 * open_opportunities_untrusted: names and titles can come from model output on earlier hostile
 * mail (FR-M3), so they are fenced like the message itself; line() stays as defense in depth.
 */
export async function openOpportunitiesText(db: Db, ctx: UserCtx): Promise<string> {
  const rows = await db
    .select({ company: companies.name, title: opportunities.title, stage: opportunities.stage })
    .from(opportunities)
    .innerJoin(companies, eq(companies.id, opportunities.companyId))
    .where(
      and(
        eq(opportunities.userId, ctx.userId),
        notInArray(opportunities.stage, ['dismissed', 'closed']),
      ),
    )
    .orderBy(desc(opportunities.updatedAt))
    .limit(MAX_OPEN_OPPORTUNITIES)
    .all();
  if (rows.length === 0) return 'None.';
  return rows.map((r) => `- ${line(r.company)} | ${line(r.title)} | ${r.stage}`).join('\n');
}

/**
 * Reads one message's body again from its provider, for a row that has none stored
 * (Plan 3 Task 2). Null when it cannot be had: the channel cannot be asked, the message is gone,
 * or the attempt failed.
 */
export type BodyRefetch = (row: typeof communications.$inferSelect) => Promise<string | null>;

/**
 * What the classifier is shown, in order of how much it is worth: the body from the job payload
 * (Plan 3 Task 1, the only place a body exists at sync time), then a body the provider can be
 * asked for again, then a stored file if this row still has one, then the snippet.
 *
 * The fallback chain is the design, not defensiveness. A classification from the snippet is a
 * worse classification; a classification that refuses to happen is a message the user never
 * hears about again.
 */
async function messageText(
  storage: Storage,
  row: typeof communications.$inferSelect,
  handed?: string,
  refetch?: BodyRefetch,
): Promise<{ text: string; source: BodySource }> {
  let body = row.snippet ?? '';
  let source: BodySource = 'snippet';
  if (handed !== undefined && handed.length > 0) {
    body = handed;
    source = 'payload';
  } else if (row.bodyRef !== null) {
    body = (await buffer(await storage.openAttachment(row.bodyRef))).toString('utf8');
    source = 'stored';
  } else if (refetch !== undefined) {
    const fetched = await refetch(row);
    if (fetched !== null && fetched.length > 0) {
      body = fetched;
      source = 'refetched';
    }
  }
  if (body.length > MAX_BODY_CHARS) body = `${body.slice(0, MAX_BODY_CHARS)}\n[truncated]`;
  const text = [
    `From: ${row.from}`,
    `To: ${row.to.join(', ')}`,
    `Subject: ${row.subject ?? ''}`,
    `Date: ${new Date(row.sentAt).toISOString()}`,
    '',
    body,
  ].join('\n');
  return { text, source };
}

export type ClassifyRun =
  | { status: 'classified'; outcome: ApplyOutcome; bodySource: BodySource }
  | { status: 'alert_digest'; leads: number }
  | { status: 'skipped'; reason: 'missing' | 'no_key' | 'no_prompt' | 'filtered' };

/** Classifies one of the user's messages and applies the result. */
export async function classifyCommunication(
  db: Db,
  ctx: UserCtx,
  storage: Storage,
  communicationId: string,
  /** The body, from the job payload: it is not stored (Plan 3 Task 1). */
  body?: string,
  /** How to read the body again when the payload has none (Plan 3 Task 2). */
  refetch?: BodyRefetch,
): Promise<ClassifyRun> {
  const row = await db
    .select()
    .from(communications)
    .where(and(eq(communications.userId, ctx.userId), eq(communications.id, communicationId)))
    .get();
  if (row === undefined) return { status: 'skipped', reason: 'missing' };
  // Stage 1 refused this message, so nothing here may send any part of it to a model, not even
  // the From header that messageText renders. The backfill's query already excludes these; this
  // is the backstop for a job row enqueued before the rule existed, or replayed afterwards.
  if (row.triageDecision === 'filtered') return { status: 'skipped', reason: 'filtered' };
  if (await isAlertDigest(db, ctx, row.from)) {
    const digest = await processAlertDigest(db, ctx, storage, row.id, body);
    return {
      status: 'alert_digest',
      leads: digest.status === 'processed' ? digest.stats.inserted : 0,
    };
  }
  const prompt = await getActivePrompt(db, ctx, 'comms.classify');
  if (prompt === undefined) return { status: 'skipped', reason: 'no_prompt' };
  const { text: message, source: bodySource } = await messageText(storage, row, body, refetch);
  const system = renderPrompt(prompt.body, {
    role_targets: await roleTargetsText(db, ctx),
    open_opportunities_untrusted: await openOpportunitiesText(db, ctx),
    message_untrusted: message,
  });
  let output: ClassifyOutput;
  try {
    output = await runStructured(await buildAiDeps(db, ctx), 'comms.classify', {
      system,
      prompt: 'Classify the message and return the result.',
      schema: ClassifyOutputSchema,
      promptId: prompt.id,
    });
  } catch (err) {
    // Without a key nothing can succeed; the message stays unclassified until a re-run.
    if (err instanceof AiUnavailableError && err.reason === 'no_key') {
      return { status: 'skipped', reason: 'no_key' };
    }
    throw err;
  }
  const outcome = await applyClassification(db, ctx, row.id, output, bodySource);
  // A just-created outreach opportunity enters the pipeline bare; enrichment goes and finds
  // the posting on the company's careers page or ATS board and fills the record (issue #16).
  if (outcome.createdOpportunityId !== null) {
    await enqueueEnrich(db, ctx.userId, outcome.createdOpportunityId);
  }
  return { status: 'classified', outcome, bodySource };
}

const PayloadSchema = z.object({
  communicationId: z.string().min(1).max(64),
  /**
   * The message body, which is not persisted anywhere else (Plan 3 Task 1). It is in the payload
   * only until this job finishes: `transientPayloadKeys` has the runner strip it then, so a
   * finished job row is not the copy of the message that outlives the message.
   */
  body: z.string().optional(),
});

export const classifyJob: JobHandler<z.infer<typeof PayloadSchema>> = {
  kind: CLASSIFY_JOB_KIND,
  payloadSchema: PayloadSchema,
  maxAttempts: 3,
  transientPayloadKeys: ['body'],
  async run(db, payload, ctx) {
    if (ctx.userId === null) throw new Error('comms.classify needs a user');
    const user: UserCtx = { userId: ctx.userId, isAdmin: false };
    // Only Gmail can be asked for a message again, and only this job needs to ask: the sync
    // hands the body over directly. A failure here is a worse classification, never a lost
    // message, so it is logged and the snippet is used.
    const provider = ctx.services.mailProvider;
    const refetch: BodyRefetch = async (row) => {
      // The injected provider is Gmail's, so another channel's id would only buy a token
      // refresh and a 404 for every message of a backfill.
      if (row.channel !== 'gmail' || provider?.fetchBody === undefined) return null;
      try {
        return await provider.fetchBody(db, user, row.externalId);
      } catch (err) {
        ctx.services.log?.warn(
          { communicationId: row.id, channel: row.channel, err },
          'could not read the message again; classifying on the snippet',
        );
        return null;
      }
    };
    const run = await classifyCommunication(
      db,
      user,
      requireService(ctx, 'storage'),
      payload.communicationId,
      payload.body,
      refetch,
    );
    // Condition 2 (issue #69): a classification run on the ~200-character snippet must be
    // distinguishable from one run on the full message, not just correct. The exception-path log
    // above covers why a refetch failed; this covers every way the chain can still land on the
    // snippet without ever throwing (no payload, nothing stored, wrong channel for a refetch, or
    // a refetch that came back empty).
    if (run.status === 'classified' && run.bodySource === 'snippet') {
      ctx.services.log?.warn(
        { communicationId: payload.communicationId },
        'classified from the snippet only; the full message text was not available',
      );
    }
    await ctx.setResult(
      run.status === 'classified'
        ? {
            status: run.status,
            classification: run.outcome.communication.classification,
            createdOpportunityId: run.outcome.createdOpportunityId,
            bodySource: run.bodySource,
          }
        : run,
    );
  },
};
