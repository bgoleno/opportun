// comms.classify job (FR-M2, M3, M8). Renders the comms.classify prompt with the message as
// untrusted data, the user's role targets and the opportunities they track, runs the structured
// task, then hands the output to the deterministic post-processing in repos/communications.
// Job alert digests (Task 12) never reach the model: they are routed to the alert-email lead
// parser instead (normally at sync time; here too, for backfills and retries).
import { CLASSIFY_JOB_KIND } from '../lib/mailClassifyQueue';
import { buffer } from 'node:stream/consumers';
import {
  AiUnavailableError,
  ClassifyOutputSchema as AiClassifyOutputSchema,
  runStructured,
  systemWithCacheBreak,
} from '@opportun/ai';
import { seniorityRangeText, type BodySource } from '@opportun/core';
import { and, desc, eq, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { isAlertDigest, processAlertDigest } from '../adapters/sources/alertEmail';
import type { ReadAgain } from '../adapters/mailProvider';
import { withTransaction, type Db } from '../db/client';
import { decryptSecret } from '../lib/secretBox';
import { communications, companies, opportunities, roleTargets } from '../db/schema';
import { buildAiDeps } from '../lib/ai';
import { senderAddress } from '../lib/mailAddress';
import { triageMessage, triageSender, type TriageRule } from '../lib/mailTriage';
import { line } from '../lib/promptText';
import { racePoint } from '../lib/racePoints';
import type { Storage } from '../lib/storage';
import { triageContext } from '../lib/triageContext';
import type { UserCtx } from '../repos/base';
import {
  classifyKeyRejected,
  readClassifyKeyChangedAt,
  setClassifyFailedIfUnsaid,
  setClassifyWait,
} from '../repos/classifyWait';
import {
  applyClassification,
  isSameMessage,
  threadLinked,
  type ApplyOutcome,
} from '../repos/communications';
import { keyChangeScope } from '../repos/discoveryBudget';
import { getActivePrompt } from '../repos/prompts';
import { enqueueEnrich } from './opportunityEnrich';
import { requireService, type JobHandler, type JobServices } from './registry';

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
 * Tracked opportunities that are still open (company, title, stage), as the comms.classify prompt
 * lists them: the MAX_OPEN_OPPORTUNITIES most recently updated, in the order they were created,
 * then by id. A stable order, because the list sits in the provider-cached prefix, and one cache
 * entry covers the whole prefix: listed by updatedAt, every message a sync batch linked reordered
 * it and made the next call write the whole prefix again, rules included (#380, tl). The template
 * asks for no order. Rendered as open_opportunities_untrusted: names and titles can come from
 * model output on earlier hostile mail (FR-M3), so they are fenced like the message itself;
 * line() stays as defense in depth.
 */
export async function openOpportunitiesText(db: Db, ctx: UserCtx): Promise<string> {
  const rows = await db
    .select({
      id: opportunities.id,
      createdAt: opportunities.createdAt,
      company: companies.name,
      title: opportunities.title,
      stage: opportunities.stage,
    })
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
  rows.sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return rows.map((r) => `- ${line(r.company)} | ${line(r.title)} | ${r.stage}`).join('\n');
}

type Message = typeof communications.$inferSelect;

/**
 * Reads one message again from its provider, for a row that has no body stored (Plan 3 Task 2). Null
 * when it cannot be had: the channel cannot be asked, the message is gone, or the attempt failed. What
 * it answers is checked against the row before it is used (messageText).
 */
export type BodyRefetch = (row: Message) => Promise<ReadAgain | null>;

/** How a job reads a message again: Gmail alone can be asked. Nothing it answers is stored. */
export function bodyRefetchFor(
  db: Db,
  ctx: UserCtx,
  services: Partial<Pick<JobServices, 'mailProvider' | 'log'>>,
): BodyRefetch {
  const provider = services.mailProvider;
  return async (row) => {
    // The injected provider is Gmail's, so another channel's id would only buy a token refresh and a
    // 404 for every message of a backfill.
    if (row.channel !== 'gmail' || provider?.readAgain === undefined) return null;
    try {
      return await provider.readAgain(db, ctx, row.externalId);
    } catch (err) {
      // A worse classification, never a lost message.
      services.log?.warn(
        { 'opportun.communication.id': row.id, 'opportun.mail.channel': row.channel, err },
        'could not read the message again; classifying on the snippet',
      );
      return null;
    }
  };
}

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
  row: Message,
  handed?: string,
  refetch?: BodyRefetch,
): Promise<{ text: string; body: string; cc?: string[]; source: BodySource }> {
  let body = row.snippet ?? '';
  let cc: string[] | undefined;
  let source: BodySource = 'snippet';
  if (handed !== undefined && handed.length > 0) {
    body = handed;
    source = 'payload';
  } else if (row.bodyRef !== null) {
    body = (await buffer(await storage.openAttachment(row.bodyRef))).toString('utf8');
    source = 'stored';
  } else if (refetch !== undefined) {
    const read = await refetch(row);
    // The mailbox connected now may not be the one this message came from, and an id may be another
    // message's there: what is read is used only when it says that it is this one (#1050).
    if (read !== null && read.bodyText.length > 0 && isSameMessage(row, read)) {
      body = read.bodyText;
      cc = read.cc;
      source = 'refetched';
    }
  }
  const shown =
    body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n[truncated]` : body;
  const text = [
    `From: ${row.from}`,
    `To: ${row.to.join(', ')}`,
    `Subject: ${row.subject ?? ''}`,
    `Date: ${new Date(row.sentAt).toISOString()}`,
    '',
    shown,
  ].join('\n');
  return { text, body, ...(cc === undefined ? {} : { cc }), source };
}

/**
 * What of the local check of the text (lib/mailTriage) is a block. Not `no_signal`, which is a
 * snippet's too; a denied or a consumer sender has been one by the sender alone, with the same rules.
 */
const TEXT_VETOES: ReadonlySet<TriageRule> = new Set(['private_content', 'auto_unsubscribe']);

/**
 * The local check again, for a classification that has no text of its own job: it can be a month after
 * the message came, and the user may have blocked its sender, or what it is, since (#1050, sec). With
 * the rules as they are now, by the sender alone before anything is read again, and then with the text
 * in hand, before the call. Nothing of what is stored changes by it (spec D7).
 */
async function blockedSince(
  db: Db,
  ctx: UserCtx,
  row: Message,
): Promise<{ sender: boolean; text: (body: string, cc?: string[]) => boolean }> {
  const address = senderAddress(row.from);
  const [rules, consumerVeto, selfAddress] = await triageContext(db, ctx);
  const linked = await threadLinked(db, ctx, row.threadKey ?? '');
  const sender = triageSender(address, rules, consumerVeto && !linked, selfAddress);
  return {
    sender: sender.decision === 'drop',
    text: (body, cc) => {
      const verdict = triageMessage({
        address,
        subject: row.subject ?? '',
        body,
        rules,
        consumerVeto,
        selfAddress,
        threadLinked: linked,
        digestSender: false,
        recipients: row.to,
        ...(cc === undefined ? {} : { cc }),
      });
      return verdict.decision === 'drop' && TEXT_VETOES.has(verdict.matchedRule);
    },
  };
}

/**
 * Whether the user's calls are stopped (repos/classifyWait classifyKeyRejected), the message then
 * saying so. Decided under the lock that ends a stop: one that had just ended would begin again by a
 * message that read it a moment before, with nothing left to end it.
 */
async function stopsAtKey(db: Db, ctx: UserCtx, id: string): Promise<boolean> {
  if (!(await classifyKeyRejected(db, ctx))) return false;
  await racePoint('classify.stopped');
  return await withTransaction(
    db,
    async (tx) => {
      if (!(await classifyKeyRejected(tx, ctx))) return false;
      await setClassifyWait(tx, ctx, id, 'key_rejected');
      return true;
    },
    { scope: keyChangeScope(ctx) },
  );
}

export type ClassifyRun =
  | { status: 'classified'; outcome: ApplyOutcome; bodySource: BodySource }
  | { status: 'alert_digest'; leads: number }
  | {
      status: 'skipped';
      reason:
        | 'missing'
        | 'no_key'
        | 'no_prompt'
        | 'filtered'
        | 'rejected'
        | 'classified'
        | 'blocked'
        | 'no_text'
        | 'budget_exceeded'
        | 'key_rejected'
        | 'key_changed';
    };

/**
 * Classifies one of the user's messages and applies the result. Where it cannot be for a reason that
 * is not this message's, the row says which (repos/classifyWait): the budget, the key, or that the user
 * has blocked it since. An outage or an unusable answer throws, as the caller's tries are its own.
 */
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
  // The user rejected it: nothing more is made of it.
  if (row.rejectedAt !== null) return { status: 'skipped', reason: 'rejected' };
  // The user's own correction, or another try's: nothing is sent.
  if (row.classification !== null) return { status: 'skipped', reason: 'classified' };
  const ownText = body !== undefined && body.length > 0;
  const blocked = ownText ? null : await blockedSince(db, ctx, row);
  const isBlocked = async (): Promise<ClassifyRun> => {
    await setClassifyWait(db, ctx, row.id, 'blocked');
    return { status: 'skipped', reason: 'blocked' };
  };
  if (blocked?.sender === true) return await isBlocked();
  if (await isAlertDigest(db, ctx, row.from)) {
    let text = body;
    if (!ownText) {
      const read = await messageText(storage, row, undefined, refetch);
      // Its leads are in the whole of it, and marked as read it would not be read again: so nothing is
      // made of a snippet (#1050).
      if (read.source === 'snippet') {
        await setClassifyWait(db, ctx, row.id, 'failed');
        return { status: 'skipped', reason: 'no_text' };
      }
      text = read.body;
    }
    const digest = await processAlertDigest(db, ctx, storage, row.id, text);
    return {
      status: 'alert_digest',
      leads: digest.status === 'processed' ? digest.stats.inserted : 0,
    };
  }
  const prompt = await getActivePrompt(db, ctx, 'comms.classify');
  if (prompt === undefined) return { status: 'skipped', reason: 'no_prompt' };
  // The provider has refused this user's key: each further call would only send it a message more
  // (#261). It ends with the key, or with another policy for this task (resumeClassifyAfterKeyChange).
  if (await stopsAtKey(db, ctx, row.id)) return { status: 'skipped', reason: 'key_rejected' };
  const {
    text: message,
    body: read,
    cc,
    source: bodySource,
  } = await messageText(storage, row, body, refetch);
  if (blocked?.text(read, cc) === true) return await isBlocked();
  // The cacheable prefix ends before the message (#380): the instructions, the role targets and
  // the open opportunities repeat for every message of a sync batch; the router marks it for the
  // provider's cache when the provider and the prefix's size allow.
  const { system, cacheBreak } = systemWithCacheBreak(
    prompt.body,
    {
      role_targets: await roleTargetsText(db, ctx),
      open_opportunities_untrusted: await openOpportunitiesText(db, ctx),
      message_untrusted: message,
    },
    'comms.classify',
  );
  let output: ClassifyOutput;
  // Before the key is read for this call.
  const callBegan = Date.now();
  await racePoint('classify.call');
  try {
    output = await runStructured(await buildAiDeps(db, ctx), 'comms.classify', {
      system,
      cacheBreak,
      prompt: 'Classify the message and return the result.',
      schema: ClassifyOutputSchema,
      promptId: prompt.id,
    });
  } catch (err) {
    if (!(err instanceof AiUnavailableError)) throw err;
    // Not back in the minutes the runner's tries take.
    if (err.reason === 'budget_exceeded') {
      await setClassifyWait(db, ctx, row.id, err.reason);
      return { status: 'skipped', reason: err.reason };
    }
    if (err.reason !== 'no_key' && !err.keyRejected) throw err;
    const reason = err.reason === 'no_key' ? 'no_key' : 'key_rejected';
    // A call that began before the latest change says nothing about what there is now: it marks
    // nothing, and is tried again with that. (A key's backfill may have passed this message by then.)
    const stale = await withTransaction(
      db,
      async (tx) => {
        if ((await readClassifyKeyChangedAt(tx, ctx)) > callBegan) return true;
        await setClassifyWait(tx, ctx, row.id, reason);
        return false;
      },
      { scope: keyChangeScope(ctx) },
    );
    return { status: 'skipped', reason: stale ? 'key_changed' : reason };
  }
  const outcome = await applyClassification(db, ctx, row.id, output, bodySource);
  if (outcome === null) {
    // Rejected meanwhile, or classified: by the user, or by another try.
    const now = await db
      .select({ rejectedAt: communications.rejectedAt })
      .from(communications)
      .where(and(eq(communications.userId, ctx.userId), eq(communications.id, row.id)))
      .get();
    return { status: 'skipped', reason: now?.rejectedAt === null ? 'classified' : 'rejected' };
  }
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
   * The message body, which is not persisted anywhere else (Plan 3 Task 1), sealed with the
   * instance's secretBox key (#175; enqueueClassify). It is in the payload only until this job
   * finishes: `transientPayloadKeys` has the runner strip it then, so a finished job row is not
   * the copy of the message that outlives the message.
   */
  bodySealed: z.string().optional(),
  /**
   * The body in the clear, as versions before #175 queued it. Read only so that a job queued
   * before an upgrade still runs (and is still stripped); nothing writes it now.
   */
  body: z.string().optional(),
});

/**
 * Opens the payload's body. A key that cannot open it (the master key changed while the job
 * waited, or the payload was altered) fails the run, which must not go on as if the message had
 * no body. The runner treats it like any other failure: it tries again with its backoff, so the
 * job's three attempts (maxAttempts) take about three minutes, and then gives the job up
 * (`dead`), its body cleared like any finished job's. Retrying helps only if the key is put back
 * meanwhile; nothing marks this error as final, because the runner has no such kind
 * (#176 item 4). The error says nothing of the body, and keeps none of the cipher's own message,
 * so neither a log line nor jobs.last_error can carry any of it.
 */
function payloadBody(db: Db, payload: z.infer<typeof PayloadSchema>): string | undefined {
  if (payload.bodySealed === undefined) return payload.body;
  try {
    return decryptSecret(db, payload.bodySealed);
  } catch {
    throw new Error(
      "the message body could not be decrypted with this instance's secrets key (was the key changed?)",
    );
  }
}

export const classifyJob: JobHandler<z.infer<typeof PayloadSchema>> = {
  kind: CLASSIFY_JOB_KIND,
  payloadSchema: PayloadSchema,
  maxAttempts: 3,
  transientPayloadKeys: ['bodySealed', 'body'],
  async run(db, payload, ctx) {
    if (ctx.userId === null) throw new Error('comms.classify needs a user');
    const user: UserCtx = { userId: ctx.userId, isAdmin: false };
    // Only Gmail can be asked for a message again, and only a run without the sync's own text asks.
    let run: ClassifyRun | { status: 'skipped'; reason: 'provider_error' | 'invalid_output' };
    try {
      run = await classifyCommunication(
        db,
        user,
        requireService(ctx, 'storage'),
        payload.communicationId,
        payloadBody(db, payload),
        bodyRefetchFor(db, user, ctx.services),
      );
      // Tried again with the key there is now, by the runner: the text is in this job.
      if (run.status === 'skipped' && run.reason === 'key_changed') {
        throw new AiUnavailableError('provider_error', 'the key changed during the call');
      }
      if (run.status === 'skipped' && run.reason === 'no_prompt') {
        await setClassifyFailedIfUnsaid(db, user, payload.communicationId);
      }
    } catch (err) {
      // The runner's tries are over: it is not dead but waits, and a later try takes it
      // (jobs/classifyWaiting), or, for an answer nothing can be made of, none does.
      if (!(err instanceof AiUnavailableError) || ctx.attempt < ctx.maxAttempts) throw err;
      const reason = err.reason === 'invalid_output' ? 'invalid_output' : 'provider_error';
      await setClassifyWait(db, user, payload.communicationId, reason);
      run = { status: 'skipped', reason };
    }
    // Condition 2 (issue #69): a classification run on the ~200-character snippet must be
    // distinguishable from one run on the full message, not just correct. The exception-path log
    // above covers why a refetch failed; this covers every way the chain can still land on the
    // snippet without ever throwing (no payload, nothing stored, wrong channel for a refetch, or
    // a refetch that came back empty).
    if (run.status === 'classified' && run.bodySource === 'snippet') {
      ctx.services.log?.warn(
        { 'opportun.communication.id': payload.communicationId },
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
  // Whatever ended it, its text is cleared and nothing would say why the message is unclassified.
  async onDead(db, payload, ctx) {
    if (ctx.userId === null) return;
    await setClassifyFailedIfUnsaid(
      db,
      { userId: ctx.userId, isAdmin: false },
      payload.communicationId,
    );
  },
};
