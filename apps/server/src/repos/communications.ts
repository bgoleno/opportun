// Communications (design 4.6): ingested copies of messages. Bodies live in storage (body_ref);
// rows are unique per (user, channel, external_id) so re-syncing is idempotent.
import {
  dedupeKey,
  newId,
  OPPORTUNITY_STAGES,
  type BodySource,
  type CommChannel,
  type CommClassification,
  type OpportunityStage,
  type OutreachKind,
} from '@opportun/core';
import { and, asc, desc, eq, isNotNull, isNull, ne, notInArray, or, type SQL } from 'drizzle-orm';
import type { InboundMessage } from '../adapters/mailProvider';
import {
  activities,
  communications,
  companies,
  dismissalFeedback,
  opportunities,
  syncState,
} from '../db/schema';
import type { AtsJobRefRecord, RejectionReason } from '../db/schema.shared';
import { extractAtsJobRefs } from '../lib/atsJobRef';
import { HttpError, notFound } from '../lib/errors';
import { cleanText, truncateText } from '../lib/safeText';
import { assertOpportunityOwned } from './activities';
import type { Db, Exec, UserCtx } from './base';
import { countWhere, likeContains, type Page } from './list';
import { rejectCommunication } from './reject';
import { createOpportunity, transitionOpportunity, type OpportunityView } from './opportunities';
import { indexActivity, indexCommunication, removeFromIndex } from './search';
import { withTransaction } from '../db/client';

export type CommunicationRow = typeof communications.$inferSelect;

const MAX_SUBJECT = 998;
const MAX_SNIPPET = 500;
const MAX_ADDRESS = 998;

/**
 * Inserts the message, or refreshes the descriptive fields of the row already stored for it.
 * Classification, links and review state are never touched here. `inserted` is true only for
 * a new row.
 */
/** The references worth storing, or null when the message carries none. */
function atsJobRefsOf(msg: InboundMessage): AtsJobRefRecord[] | null {
  const refs = extractAtsJobRefs(`${msg.subject}\n${msg.bodyText}`);
  return refs.length === 0 ? null : refs;
}

export interface TriageFields {
  decision: 'passed' | 'filtered';
  rule: string | null;
}

/**
 * No parameter carries a stored body any more (issue #53). Plan 3 Task 1 stopped the mail ingest
 * path writing one, and the LinkedIn importer went on writing them for another day, because the
 * rule lived in the callers rather than in the writer they share. A parameter that still accepts
 * the thing the design bans is a convention, not a boundary, so it is gone: `body_ref` stays on
 * the row for messages stored before this, and nothing can write it.
 */
export async function upsertInbound(
  exec: Exec,
  ctx: UserCtx,
  channel: CommChannel,
  msg: InboundMessage,
  triage?: TriageFields,
): Promise<{ id: string; inserted: boolean }> {
  // A filtered message keeps its sender, date and identifiers (enough for the blocked view and
  // its deep link back to the original) and nothing that says what it was about. The incident
  // this guards against had its private content in the subject line, so blanking the subject
  // and snippet here is the point, not a detail.
  const filtered = triage?.decision === 'filtered';
  const fields = {
    // Cleaned (no NUL, no half emoji) so the row stores on Postgres as well as SQLite.
    threadKey: cleanText(msg.threadKey),
    from: truncateText(msg.from, MAX_ADDRESS),
    to: msg.to.map((t) => truncateText(t, MAX_ADDRESS)),
    subject: filtered ? null : truncateText(msg.subject, MAX_SUBJECT),
    snippet: filtered ? null : truncateText(msg.snippet, MAX_SNIPPET),
    bodyRef: null,
    // Design D-5: the ATS job references are extracted here, where the body is in hand for the
    // last time. Plan 3 stops keeping bodies, and find-posting reads these to recover the
    // posting a recruiter linked to: re-fetching is no answer for Apple Mail or a LinkedIn
    // export, and the snippet reaches only the first few hundred characters, so a link below
    // the fold would be lost. A filtered row keeps none, for the same reason it keeps no
    // subject: a URL says what the message was about.
    atsJobRefs: filtered ? null : atsJobRefsOf(msg),
    sentAt: msg.sentAt,
    ...(triage === undefined ? {} : { triageDecision: triage.decision, triageRule: triage.rule }),
  };
  const now = Date.now();
  const proposed = newId();
  // One statement: insert, or refresh the row the unique (user_id, channel, external_id)
  // index already holds. The row is new exactly when it carries the id proposed here.
  const row = await exec
    .insert(communications)
    .values({
      id: proposed,
      userId: ctx.userId,
      channel,
      externalId: msg.externalId,
      ...fields,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [communications.userId, communications.channel, communications.externalId],
      // Triage is insert-only. A message already stored was judged under the rules in force
      // when it arrived, and spec D7 is explicit that editing the lists affects future syncs
      // and never stored history. Re-running the filter on an update would let one Gmail
      // history-id expiry (which falls back to a full re-listing) blank the subject and
      // snippet of every already-stored message a new rule now covers, orphan its body file,
      // and leave its text in the search index with no row pointing at it.
      set: filtered ? { updatedAt: now } : { ...fields, updatedAt: now },
    })
    .returning({ id: communications.id })
    .get();
  if (row === undefined) throw new Error('upsertInbound: no row returned');
  // A filtered row has no subject or snippet to index, and indexing it anyway would leave a
  // fully searchable second copy of exactly the text this feature refuses to store. The
  // removal is belt and braces: triage is insert-only, so a filtered row should never already
  // carry an index entry, but an index row that outlived its text is the failure that is
  // invisible until someone searches for it.
  if (filtered) {
    await removeFromIndex(exec, ctx, 'communication', row.id);
  } else {
    await indexCommunication(exec, ctx, {
      id: row.id,
      subject: fields.subject,
      snippet: fields.snippet,
    });
  }
  return { id: row.id, inserted: row.id === proposed };
}

// ---------------------------------------------------------------------------
// Sync state

export type SyncStateRow = typeof syncState.$inferSelect;

export async function getSyncState(
  db: Db,
  ctx: UserCtx,
  integration: string,
): Promise<SyncStateRow | undefined> {
  return await db
    .select()
    .from(syncState)
    .where(and(eq(syncState.userId, ctx.userId), eq(syncState.integration, integration)))
    .get();
}

export async function putSyncState(
  exec: Exec,
  ctx: UserCtx,
  integration: string,
  patch: { cursor?: unknown; lastSyncAt?: number; status?: string },
): Promise<void> {
  await exec
    .insert(syncState)
    .values({
      userId: ctx.userId,
      integration,
      cursor: patch.cursor ?? null,
      lastSyncAt: patch.lastSyncAt ?? null,
      status: patch.status ?? null,
    })
    .onConflictDoUpdate({
      target: [syncState.userId, syncState.integration],
      set: {
        ...(patch.cursor === undefined ? {} : { cursor: patch.cursor }),
        ...(patch.lastSyncAt === undefined ? {} : { lastSyncAt: patch.lastSyncAt }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
      },
    })
    .run();
}

// ---------------------------------------------------------------------------
// Views

/** A communication as the API returns it (no body_ref: the body is fetched on demand). */
export interface CommunicationView {
  id: string;
  channel: CommChannel;
  threadKey: string | null;
  from: string;
  to: string[];
  subject: string | null;
  snippet: string | null;
  sentAt: number;
  classification: CommClassification | null;
  outreachKind: OutreachKind | null;
  mismatchReason: string | null;
  confidence: number | null;
  /** What the classifier actually read (issue #149); null for a message never classified, or
   * classified before this column existed. */
  bodySource: BodySource | null;
  opportunityId: string | null;
  opportunityTitle: string | null;
  companyName: string | null;
  opportunityStage: OpportunityStage | null;
  needsReview: boolean;
  proposedTransition: OpportunityStage | null;
  createdAt: number;
  /** The provider's own id, which the client turns into a deep link to the original. */
  externalId: string;
  /** Stage 1's verdict and the rule that reached it (spec D6), null for older rows. */
  triageDecision: string | null;
  triageRule: string | null;
}

export const INBOX_VIEWS = [
  'needs_review',
  'linked',
  'spam',
  'filtered',
  'blocked',
  'all',
] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];

/** Outreach kinds hidden from the main inbox views (FR-M8). */
const FILTERED_KINDS: OutreachKind[] = ['broadcast_spam', 'irrelevant'];

/**
 * Not broadcast spam or irrelevant outreach (NULL outreach kinds included), and not blocked by
 * Stage 1. Two different kinds of filtering share this predicate: `outreach_kind` is the
 * classifier's judgment about recruiter mail it read, `triage_decision` is Stage 1 refusing to
 * let it be read at all.
 */
const notFiltered = (): SQL =>
  and(
    or(
      isNull(communications.outreachKind),
      notInArray(communications.outreachKind, FILTERED_KINDS),
    ),
    notBlocked(),
  ) as SQL;

/** Stage 1 kept this message out of the funnel entirely (spec D6). */
const BLOCKED = 'filtered';
const notBlocked = (): SQL =>
  and(
    or(isNull(communications.triageDecision), ne(communications.triageDecision, BLOCKED)),
    notRejected(),
  ) as SQL;

/**
 * The user rejected this message as out of scope (spec D4). It is excluded from every view,
 * including `blocked`: a rejection is the user's own decision that the thing should not be
 * here at all, so leaving it listed anywhere would be the tracking they asked to be rid of.
 * The row survives only so the next sync does not re-ingest it.
 */
const notRejected = (): SQL => isNull(communications.rejectedAt) as SQL;

function viewWhere(view: InboxView): SQL | undefined {
  switch (view) {
    case 'needs_review':
      return and(eq(communications.needsReview, true), notFiltered());
    case 'linked':
      return and(isNotNull(communications.opportunityId), notFiltered());
    case 'spam':
      return and(eq(communications.outreachKind, 'broadcast_spam'), notBlocked());
    case 'filtered':
      return and(eq(communications.outreachKind, 'irrelevant'), notBlocked());
    case 'blocked':
      return and(eq(communications.triageDecision, BLOCKED), notRejected());
    case 'all':
      return notFiltered();
  }
}

const viewColumns = {
  id: communications.id,
  channel: communications.channel,
  externalId: communications.externalId,
  triageDecision: communications.triageDecision,
  triageRule: communications.triageRule,
  threadKey: communications.threadKey,
  from: communications.from,
  to: communications.to,
  subject: communications.subject,
  snippet: communications.snippet,
  sentAt: communications.sentAt,
  classification: communications.classification,
  outreachKind: communications.outreachKind,
  mismatchReason: communications.mismatchReason,
  confidence: communications.confidence,
  bodySource: communications.bodySource,
  opportunityId: communications.opportunityId,
  opportunityTitle: opportunities.title,
  companyName: companies.name,
  opportunityStage: opportunities.stage,
  needsReview: communications.needsReview,
  proposedTransition: communications.proposedTransition,
  bodyRef: communications.bodyRef,
  createdAt: communications.createdAt,
};

function selectViews(exec: Exec, ctx: UserCtx) {
  return exec
    .select(viewColumns)
    .from(communications)
    .leftJoin(
      opportunities,
      and(eq(opportunities.id, communications.opportunityId), eq(opportunities.userId, ctx.userId)),
    )
    .leftJoin(companies, eq(companies.id, opportunities.companyId));
}

type ViewRow = CommunicationView & { bodyRef: string | null };

/**
 * The view drops `bodyRef`: there is no body to serve (Plan 3 Task 1), and a pointer to one is
 * not something the client has any use for. It also suppresses a proposal the opportunity has
 * already reached by some other route (issue #143): `proposedTransition` only changes when a
 * new message is classified, so a stage change made any other way (the stage control, say)
 * leaves a stale, already-satisfied proposal sitting on the row, offering a move that would be
 * a no-op, until another message happens to arrive. This is a read-time view rather than a
 * write to the row, so the comparison is always against the opportunity's current stage, and
 * the stored value survives to be compared again if the opportunity later moves away from it.
 */
function toView(row: ViewRow): CommunicationView {
  const { bodyRef, ...view } = row;
  void bodyRef;
  return {
    ...view,
    proposedTransition:
      view.proposedTransition === view.opportunityStage ? null : view.proposedTransition,
  };
}

function ownedComm(ctx: UserCtx, id: string): SQL | undefined {
  return and(eq(communications.userId, ctx.userId), eq(communications.id, id));
}

async function getRowSync(exec: Exec, ctx: UserCtx, id: string): Promise<CommunicationRow> {
  const row = await exec.select().from(communications).where(ownedComm(ctx, id)).get();
  if (row === undefined) throw notFound();
  return row;
}

export async function getCommunicationView(
  exec: Exec,
  ctx: UserCtx,
  id: string,
): Promise<CommunicationView> {
  const row = await selectViews(exec, ctx).where(ownedComm(ctx, id)).get();
  if (row === undefined) throw notFound();
  return toView(row);
}

export interface CommunicationFilters {
  view: InboxView;
  opportunityId?: string | undefined;
  /** Source filter: list only this channel (gmail / apple_mail / linkedin). */
  channel?: CommChannel | undefined;
  /** Sender substring, matched case-insensitively against the `from` header. */
  sender?: string | undefined;
  /** Keyword across subject, snippet and sender, case-insensitive. */
  q?: string | undefined;
  /**
   * Date-received order for the inbox views. Newest first by default. A single opportunity's
   * Communications tab is always chronological (oldest first) regardless of this.
   */
  order?: 'newest' | 'oldest' | undefined;
}

/**
 * A page of the caller's messages. Inbox views list newest first; one opportunity's messages
 * (its Communications tab) list oldest first.
 */
export async function listCommunications(
  db: Db,
  ctx: UserCtx,
  opts: CommunicationFilters & { limit: number; offset: number },
): Promise<Page<CommunicationView>> {
  if (opts.opportunityId !== undefined) await assertOpportunityOwned(db, ctx, opts.opportunityId);
  const where = and(
    eq(communications.userId, ctx.userId),
    viewWhere(opts.view),
    opts.opportunityId === undefined
      ? undefined
      : eq(communications.opportunityId, opts.opportunityId),
    opts.channel === undefined ? undefined : eq(communications.channel, opts.channel),
    opts.sender === undefined || opts.sender === ''
      ? undefined
      : likeContains(communications.from, opts.sender),
    opts.q === undefined || opts.q === ''
      ? undefined
      : (or(
          likeContains(communications.subject, opts.q),
          likeContains(communications.snippet, opts.q),
          likeContains(communications.from, opts.q),
        ) as SQL),
  );
  // Inbox views honor the requested date order, newest first by default. A single opportunity's
  // thread stays chronological (oldest first) so the conversation reads top to bottom.
  const oldestFirst = opts.opportunityId !== undefined || opts.order === 'oldest';
  const order = oldestFirst
    ? [asc(communications.sentAt), asc(communications.id)]
    : [desc(communications.sentAt), desc(communications.id)];
  const items = (
    await selectViews(db, ctx)
      .where(where)
      .orderBy(...order)
      .limit(opts.limit)
      .offset(opts.offset)
      .all()
  ).map(toView);
  return { items, total: await countWhere(db, communications, where) };
}

/**
 * One triage action applied to a selection of messages. Reject only, deliberately: a bulk
 * reclassify would relink many messages to one opportunity, and `reclassify`'s own
 * `assertOpportunityOwned` 404s on an unowned link target, which is indistinguishable at this
 * layer from a 404 for "message not the caller's" and would be miscounted as a skip. When bulk
 * reclassify is actually wanted in the UI, it needs the link-target failure surfaced as a
 * distinct error (not a 404) and its own test; until then it is not exposed.
 */
export type BulkAction = {
  kind: 'reject';
  reason: RejectionReason;
  note?: string | null | undefined;
};

export interface BulkTriageInput {
  ids: readonly string[];
  action: BulkAction;
}

export interface BulkTriageResult {
  /** Distinct messages that were the caller's and were acted on. */
  succeeded: number;
  /** Distinct ids that were not the caller's (or no longer exist); left untouched. */
  skipped: number;
}

/**
 * Reject many messages at once. Each id is rejected through the same `rejectCommunication` the
 * single-row route uses, which selects on `userId AND id` and 404s otherwise, so every id is
 * scoped to the caller by construction: a 404 here can only mean "not the caller's" (the bulk
 * path passes no `neverIngest`, so reject's other error paths are unreachable), and is counted
 * as `skipped` rather than touching anything. A partial result is reported instead of failing
 * the whole batch. Ids are de-duplicated so the counts are of distinct messages, not of repeated
 * ids in the request.
 */
export async function bulkTriage(
  db: Db,
  ctx: UserCtx,
  input: BulkTriageInput,
): Promise<BulkTriageResult> {
  let succeeded = 0;
  let skipped = 0;
  for (const id of new Set(input.ids)) {
    try {
      await rejectCommunication(db, ctx, id, {
        reason: input.action.reason,
        note: input.action.note ?? null,
      });
      succeeded += 1;
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 404) {
        skipped += 1;
      } else {
        throw err;
      }
    }
  }
  return { succeeded, skipped };
}

/** Messages waiting for the user's review (the dashboard triage count). */
export async function needsReviewCount(db: Db, ctx: UserCtx): Promise<number> {
  return await countWhere(
    db,
    communications,
    and(eq(communications.userId, ctx.userId), viewWhere('needs_review')),
  );
}

// ---------------------------------------------------------------------------
// Classification post-processing (FR-M2, M3, M8). Deterministic: given the classifier output
// and the current data, the same links, flags and proposals result every time.

export const NEEDS_REVIEW_BELOW = 0.5;
export const PROPOSAL_MIN_CONFIDENCE = 0.7;

/** Classifications about a job process (networking and other are not). */
const JOB_RELATED: ReadonlySet<CommClassification> = new Set([
  'solicitation',
  'scheduling',
  'follow_up',
  'rejection',
  'offer',
]);

/** The only stage each kind of message may propose (scheduling an interview means in_process). */
const PROPOSAL_TARGET = new Map<CommClassification, OpportunityStage>([
  ['rejection', 'closed'],
  ['offer', 'offer'],
  ['scheduling', 'in_process'],
]);

const CHAIN: readonly OpportunityStage[] = OPPORTUNITY_STAGES.filter(
  (s) => s !== 'dismissed' && s !== 'closed',
);
const isTerminal = (s: OpportunityStage): boolean => s === 'dismissed' || s === 'closed';

const COMPANY_SUFFIXES: ReadonlySet<string> = new Set([
  'inc',
  'incorporated',
  'llc',
  'ltd',
  'limited',
  'corp',
  'corporation',
  'co',
  'company',
  'gmbh',
  'plc',
  'ag',
  'sa',
  'bv',
  'group',
  'holdings',
]);

function words(value: string): string[] {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 0);
}

/** Company names compared without case, punctuation and legal suffixes. */
export function companyKey(name: string): string {
  return words(name)
    .filter((w) => !COMPANY_SUFFIXES.has(w))
    .join(' ');
}

/** Same company: equal keys, or one key is a whole-word prefix of the other ("Acme" / "Acme Robotics"). */
export function sameCompany(a: string, b: string): boolean {
  const ka = companyKey(a);
  const kb = companyKey(b);
  if (ka.length === 0 || kb.length === 0) return false;
  if (ka === kb) return true;
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  return short.length >= 4 && long.startsWith(`${short} `);
}

/** Jaccard similarity of title words, after the seniority-stripping dedupe normalization. */
export function titleSimilarity(a: string, b: string): number {
  const ta = new Set((dedupeKey('', a, '').split('|')[1] ?? '').split(' ').filter(Boolean));
  const tb = new Set((dedupeKey('', b, '').split('|')[1] ?? '').split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let both = 0;
  for (const t of ta) if (tb.has(t)) both += 1;
  return both / (ta.size + tb.size - both);
}

const TITLE_MATCH = 0.5;

interface Candidate {
  id: string;
  title: string;
  stage: OpportunityStage;
  companyName: string;
  updatedAt: number;
}

/**
 * The opportunity a classifier match refers to. Among the caller's opportunities at the same
 * company, the best title match (similarity >= 0.5) wins, live stages before closed/dismissed,
 * then the most recently updated. With no title match, a message that is not new outreach
 * links to the company's only live opportunity (rejections rarely repeat the title).
 */
async function resolveMatch(
  exec: Exec,
  ctx: UserCtx,
  match: { company: string; title: string },
  classification: CommClassification,
): Promise<Candidate | undefined> {
  const all = await exec
    .select({
      id: opportunities.id,
      title: opportunities.title,
      stage: opportunities.stage,
      companyName: companies.name,
      updatedAt: opportunities.updatedAt,
    })
    .from(opportunities)
    .innerJoin(companies, eq(companies.id, opportunities.companyId))
    .where(eq(opportunities.userId, ctx.userId))
    .all();
  const atCompany = all.filter((o) => sameCompany(o.companyName, match.company));
  if (atCompany.length === 0) return undefined;
  const scored = atCompany
    .map((o) => ({ o, score: titleSimilarity(o.title, match.title) }))
    .filter((x) => x.score >= TITLE_MATCH)
    .sort(
      (x, y) =>
        y.score - x.score ||
        Number(isTerminal(x.o.stage)) - Number(isTerminal(y.o.stage)) ||
        y.o.updatedAt - x.o.updatedAt ||
        (x.o.id < y.o.id ? -1 : 1),
    );
  if (scored[0] !== undefined) return scored[0].o;
  if (classification === 'solicitation') return undefined;
  const live = atCompany.filter((o) => !isTerminal(o.stage));
  return live.length === 1 ? live[0] : undefined;
}

/** Thread continuity: the opportunity another message in the same thread is linked to. */
async function threadLink(
  exec: Exec,
  ctx: UserCtx,
  comm: CommunicationRow,
): Promise<string | undefined> {
  if (comm.threadKey === null) return undefined;
  return (
    (
      await exec
        .select({ opportunityId: communications.opportunityId })
        .from(communications)
        .innerJoin(
          opportunities,
          and(
            eq(opportunities.id, communications.opportunityId),
            eq(opportunities.userId, ctx.userId),
          ),
        )
        .where(
          and(
            eq(communications.userId, ctx.userId),
            eq(communications.channel, comm.channel),
            eq(communications.threadKey, comm.threadKey),
            ne(communications.id, comm.id),
            isNotNull(communications.opportunityId),
          ),
        )
        .orderBy(desc(communications.sentAt), desc(communications.id))
        .get()
    )?.opportunityId ?? undefined
  );
}

async function opportunityStage(
  exec: Exec,
  ctx: UserCtx,
  id: string,
): Promise<OpportunityStage | undefined> {
  return (
    await exec
      .select({ stage: opportunities.stage })
      .from(opportunities)
      .where(and(eq(opportunities.userId, ctx.userId), eq(opportunities.id, id)))
      .get()
  )?.stage;
}

/**
 * The stage change to propose, or null. Only rejection, offer and scheduling messages on a
 * linked opportunity propose, only with confidence >= 0.7, only when the classifier named the
 * matching stage, and only for a move forward (or a close). A proposal on a closed or dismissed
 * opportunity is kept: accepting it is an explicit reopen.
 */
export function proposalFor(
  classification: CommClassification,
  proposed: OpportunityStage | null,
  confidence: number,
  current: OpportunityStage | undefined,
): OpportunityStage | null {
  if (current === undefined || proposed === null) return null;
  if (confidence < PROPOSAL_MIN_CONFIDENCE) return null;
  const target = PROPOSAL_TARGET.get(classification);
  if (target === undefined || target !== proposed || target === current) return null;
  if (isTerminal(current) || isTerminal(target)) return target;
  return CHAIN.indexOf(target) > CHAIN.indexOf(current) ? target : null;
}

export function needsReviewFor(
  classification: CommClassification,
  outreachKind: OutreachKind | null,
  confidence: number,
  linked: boolean,
): boolean {
  if (outreachKind === 'broadcast_spam' || outreachKind === 'irrelevant') return false;
  if (confidence < NEEDS_REVIEW_BELOW) return true;
  return JOB_RELATED.has(classification) && !linked;
}

export interface ClassifyResult {
  classification: CommClassification;
  outreachKind: OutreachKind | null;
  mismatchReason: string | null;
  opportunityMatch: { company: string; title: string } | null;
  proposedTransition: OpportunityStage | null;
  confidence: number;
  /** A stated pay/location conflict with a role target; see ClassifyOutputSchema. */
  hardConstraintViolation: string | null;
}

export interface ApplyOutcome {
  communication: CommunicationView;
  /** Set when this run created an opportunity from targeted outreach (FR-M3). */
  createdOpportunityId: string | null;
}

/**
 * Stores a classifier result and derives everything else: the link (an existing link stays,
 * then thread continuity, then the company/title match), opportunity creation for unmatched
 * targeted outreach, the stored (never applied) transition proposal, and the review flag.
 * Running it twice for the same message creates nothing the second time.
 */
export async function applyClassification(
  db: Db,
  ctx: UserCtx,
  id: string,
  out: ClassifyResult,
  /** What the classifier actually read (issue #149), stored alongside the result so a
   * classification based on the ~200-character snippet is distinguishable afterward from one
   * based on the full message, not just correct or not. */
  bodySource: BodySource,
): Promise<ApplyOutcome> {
  const comm = await getRowSync(db, ctx, id);
  const classification = out.classification;
  // A stated hard-constraint violation (pay below the target's floor, relocation against a
  // remote preference) makes solicitation irrelevant deterministically, whatever outreachKind
  // the model chose: the prompt's tie-break has been wrong before (Umbrella InMail, 2026-10-17),
  // and this guard keeps such outreach from auto-entering the pipeline.
  const violation = (out.hardConstraintViolation ?? '').trim().slice(0, 300) || null;
  const outreachKind =
    classification === 'solicitation'
      ? violation === null
        ? out.outreachKind
        : 'irrelevant'
      : null;
  const mismatchReason =
    outreachKind === 'irrelevant'
      ? ((out.mismatchReason?.trim().slice(0, 300) || null) ?? violation)
      : null;
  const filtered = outreachKind === 'broadcast_spam' || outreachKind === 'irrelevant';
  const match =
    out.opportunityMatch !== null &&
    out.opportunityMatch.company.trim().length > 0 &&
    out.opportunityMatch.title.trim().length > 0
      ? {
          company: out.opportunityMatch.company.trim().slice(0, 200),
          title: out.opportunityMatch.title.trim().slice(0, 300),
        }
      : null;

  let opportunityId = comm.opportunityId;
  if (opportunityId === null && !filtered) {
    opportunityId =
      (await threadLink(db, ctx, comm)) ??
      (match === null ? undefined : (await resolveMatch(db, ctx, match, classification))?.id) ??
      null;
  }

  let createdOpportunityId: string | null = null;
  if (
    opportunityId === null &&
    classification === 'solicitation' &&
    outreachKind === 'targeted' &&
    match !== null
  ) {
    try {
      const opp = await createOpportunity(db, ctx, {
        companyName: match.company,
        title: match.title,
        sourceKind: 'communication',
      });
      opportunityId = opp.id;
      createdOpportunityId = opp.id;
    } catch (err) {
      // The dedupe machinery is the backstop: an opportunity with the same key exists.
      if (!(err instanceof HttpError && err.code === 'duplicate')) throw err;
      const existing = err.details?.existingId;
      if (typeof existing !== 'string') throw err;
      opportunityId = existing;
    }
  }

  return await withTransaction(db, async (tx) => {
    const stage =
      opportunityId === null ? undefined : await opportunityStage(tx, ctx, opportunityId);
    const proposal = proposalFor(classification, out.proposedTransition, out.confidence, stage);
    const now = Date.now();
    await tx
      .update(communications)
      .set({
        classification,
        outreachKind,
        mismatchReason,
        confidence: out.confidence,
        bodySource,
        opportunityId,
        proposedTransition: proposal,
        // An auto-created opportunity is always surfaced for a human glance: the link it
        // just made would otherwise suppress the review flag for its own creation.
        needsReview:
          createdOpportunityId !== null ||
          needsReviewFor(classification, outreachKind, out.confidence, opportunityId !== null),
        updatedAt: now,
      })
      .where(ownedComm(ctx, id))
      .run();
    if (createdOpportunityId !== null) {
      await tx
        .update(opportunities)
        .set({ sourceRef: `${comm.channel}:${comm.externalId}`.slice(0, 500) })
        .where(
          and(eq(opportunities.userId, ctx.userId), eq(opportunities.id, createdOpportunityId)),
        )
        .run();
      const activity = await tx
        .insert(activities)
        .values({
          id: newId(),
          userId: ctx.userId,
          opportunityId: createdOpportunityId,
          kind: 'message_ref',
          title: (comm.subject ?? '').trim() || `Message from ${comm.from}`,
          bodyMd: comm.snippet,
          occurredAt: comm.sentAt,
          participants: [comm.from],
          externalUrl: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      await indexActivity(tx, ctx, activity);
    }
    return { communication: await getCommunicationView(tx, ctx, id), createdOpportunityId };
  });
}

// ---------------------------------------------------------------------------
// User corrections and accepted proposals

export interface ReclassifyInput {
  classification?: CommClassification | undefined;
  outreachKind?: OutreachKind | null | undefined;
  /** null unlinks; undefined leaves the link alone. */
  opportunityId?: string | null | undefined;
}

const label = (v: string | null): string => v ?? 'none';

/**
 * The user's correction: records a classification feedback row (FR-D6 pattern) and relinks.
 * A changed link drops the stored proposal, which was about the old opportunity.
 */
export async function reclassify(
  db: Db,
  ctx: UserCtx,
  id: string,
  input: ReclassifyInput,
): Promise<CommunicationView> {
  return await withTransaction(db, async (tx) => {
    const comm = await getRowSync(tx, ctx, id);
    if (input.opportunityId != null) await assertOpportunityOwned(tx, ctx, input.opportunityId);
    const classification = input.classification ?? comm.classification ?? 'other';
    let outreachKind: OutreachKind | null =
      input.outreachKind === undefined ? comm.outreachKind : input.outreachKind;
    if (classification !== 'solicitation') outreachKind = null;
    const filtered = outreachKind === 'broadcast_spam' || outreachKind === 'irrelevant';
    // Spam and irrelevant outreach is never linked unless the user links it in the same call.
    const opportunityId =
      input.opportunityId !== undefined
        ? input.opportunityId
        : filtered
          ? null
          : comm.opportunityId;
    const linkChanged = opportunityId !== comm.opportunityId;

    const changes: string[] = [];
    if (classification !== comm.classification) {
      changes.push(`classification ${label(comm.classification)} -> ${classification}`);
    }
    if (outreachKind !== comm.outreachKind) {
      changes.push(`outreach ${label(comm.outreachKind)} -> ${label(outreachKind)}`);
    }
    if (linkChanged) changes.push(opportunityId === null ? 'unlinked' : 'relinked');
    const now = Date.now();
    await tx
      .insert(dismissalFeedback)
      .values({
        id: newId(),
        userId: ctx.userId,
        kind: 'classification',
        communicationId: id,
        opportunityId,
        reason: changes.length === 0 ? 'confirmed' : changes.join('; '),
        note: (comm.subject ?? '').slice(0, 200) || null,
        at: now,
      })
      .run();
    await tx
      .update(communications)
      .set({
        classification,
        outreachKind,
        mismatchReason: outreachKind === 'irrelevant' ? comm.mismatchReason : null,
        // The user's own call: not read from any body, so a bodySource from whatever the
        // classifier last ran on would now describe a classification this is no longer.
        confidence: 1,
        bodySource: null,
        opportunityId,
        proposedTransition: linkChanged || filtered ? null : comm.proposedTransition,
        needsReview: needsReviewFor(classification, outreachKind, 1, opportunityId !== null),
        updatedAt: now,
      })
      .where(ownedComm(ctx, id))
      .run();
    return await getCommunicationView(tx, ctx, id);
  });
}

/**
 * A job alert digest (Task 12): stored, classified 'other' deterministically, never queued for
 * review and never linked or turned into an activity (a digest is not a conversation).
 */
export async function markAlertDigest(exec: Exec, ctx: UserCtx, id: string): Promise<void> {
  await exec
    .update(communications)
    .set({
      classification: 'other',
      outreachKind: null,
      mismatchReason: null,
      confidence: 1,
      // Routed deterministically, never read by the classifier at all.
      bodySource: null,
      needsReview: false,
      proposedTransition: null,
      updatedAt: Date.now(),
    })
    .where(ownedComm(ctx, id))
    .run();
}

/** Drops a stored proposal without applying it. */
export async function dismissProposal(
  db: Db,
  ctx: UserCtx,
  id: string,
): Promise<CommunicationView> {
  await getRowSync(db, ctx, id);
  await db
    .update(communications)
    .set({ proposedTransition: null, updatedAt: Date.now() })
    .where(ownedComm(ctx, id))
    .run();
  return await getCommunicationView(db, ctx, id);
}

export class NoProposalError extends HttpError {
  constructor() {
    super(409, 'no_proposal');
  }
}

/**
 * Applies the stored proposal through the opportunity state machine (Task 13), including its
 * reopen rule: leaving closed or dismissed needs `reopen`, which only the user's explicit
 * confirmation sends. A rejection closes with reason `rejected`.
 */
export async function acceptProposal(
  db: Db,
  ctx: UserCtx,
  id: string,
  opts: { reopen?: boolean | undefined },
): Promise<{ communication: CommunicationView; opportunity: OpportunityView }> {
  const comm = await getRowSync(db, ctx, id);
  if (comm.proposedTransition === null || comm.opportunityId === null) throw new NoProposalError();
  const subject = (comm.subject ?? '').trim().slice(0, 120);
  const opportunity = await transitionOpportunity(db, ctx, comm.opportunityId, {
    to: comm.proposedTransition,
    ...(comm.proposedTransition === 'closed' ? { closedReason: 'rejected' as const } : {}),
    note: subject.length > 0 ? `Proposed by message: ${subject}` : 'Proposed by a message',
    reopen: opts.reopen === true,
  });
  await db
    .update(communications)
    .set({ proposedTransition: null, updatedAt: Date.now() })
    .where(ownedComm(ctx, id))
    .run();
  return { communication: await getCommunicationView(db, ctx, id), opportunity };
}
