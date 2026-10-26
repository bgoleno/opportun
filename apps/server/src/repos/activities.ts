// Activities, next steps, the merged timeline and dashboard aggregates (FR-O3, O4, U1).
import {
  and,
  asc,
  count,
  desc,
  eq,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  newId,
  OPPORTUNITY_STAGES,
  referralBody,
  referralNoteOf,
  referralStatusOf,
  type ActivityKind,
  type CommChannel,
  type CommClassification,
  type OpportunityStage,
  type Participant,
  type ReferralStatus,
} from '@opportun/core';
import {
  activities,
  communications,
  companies,
  contacts,
  nextSteps,
  opportunities,
} from '../db/schema';
import { duplicate, HttpError, notFound } from '../lib/errors';
import type { Db, Exec, UserCtx } from './base';
import { countWhere, orderBy, sortColumns, type ListOpts, type Page } from './list';
import { indexActivity, removeFromIndex } from './search';
import { runCount, rawGet, rawAll, withTransaction } from '../db/client';
import { decodeJson, jsonArrayHasObjectWith, jsonObject, jsonValue } from '../db/dialect';

export type ActivityRow = typeof activities.$inferSelect;
export type NextStepRow = typeof nextSteps.$inferSelect;

type Writable<T> = Omit<T, 'id' | 'userId' | 'opportunityId' | 'createdAt' | 'updatedAt'>;
export type ActivityInput = Writable<typeof activities.$inferInsert>;
export type NextStepInput = Writable<typeof nextSteps.$inferInsert>;

/** 404 unless the caller owns the opportunity. */
export async function assertOpportunityOwned(
  exec: Exec,
  ctx: UserCtx,
  opportunityId: string,
): Promise<void> {
  const row = await exec
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(and(eq(opportunities.userId, ctx.userId), eq(opportunities.id, opportunityId)))
    .get();
  if (row === undefined) throw notFound();
}

// ---------------------------------------------------------------------------
// Activities

export const ACTIVITY_SORTS = sortColumns({
  occurredAt: activities.occurredAt,
  createdAt: activities.createdAt,
  updatedAt: activities.updatedAt,
});

function ownedActivity(ctx: UserCtx, id: string): SQL | undefined {
  return and(eq(activities.userId, ctx.userId), eq(activities.id, id));
}

export async function listActivities(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
  opts: ListOpts,
): Promise<Page<ActivityRow>> {
  await assertOpportunityOwned(db, ctx, opportunityId);
  const where = and(eq(activities.userId, ctx.userId), eq(activities.opportunityId, opportunityId));
  const items = await db
    .select()
    .from(activities)
    .where(where)
    .orderBy(...orderBy(opts.sort, '-occurredAt', ACTIVITY_SORTS, activities.id))
    .limit(opts.limit)
    .offset(opts.offset)
    .all();
  return { items, total: await countWhere(db, activities, where) };
}

export async function getActivitySync(exec: Exec, ctx: UserCtx, id: string): Promise<ActivityRow> {
  const row = await exec.select().from(activities).where(ownedActivity(ctx, id)).get();
  if (row === undefined) throw notFound();
  return row;
}

export async function getActivity(db: Db, ctx: UserCtx, id: string): Promise<ActivityRow> {
  return await getActivitySync(db, ctx, id);
}

export async function createActivity(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
  input: ActivityInput,
): Promise<ActivityRow> {
  return await withTransaction(db, async (tx) => {
    await assertOpportunityOwned(tx, ctx, opportunityId);
    const now = Date.now();
    const row = await tx
      .insert(activities)
      .values({
        ...input,
        id: newId(),
        userId: ctx.userId,
        opportunityId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    await indexActivity(tx, ctx, row);
    return row;
  });
}

/**
 * Patches an activity. `referralStatus` (referral activities only, else 422 not_a_referral)
 * rewrites the status line at the top of the body, keeping the note (or the new bodyMd).
 */
export async function updateActivity(
  db: Db,
  ctx: UserCtx,
  id: string,
  input: Partial<ActivityInput> & { referralStatus?: ReferralStatus | undefined },
): Promise<ActivityRow> {
  const { referralStatus, ...patch } = input;
  return await withTransaction(db, async (tx) => {
    if (referralStatus !== undefined) {
      const current = await getActivitySync(tx, ctx, id);
      if (current.kind !== 'referral') {
        throw new HttpError(422, 'not_a_referral', 'only a referral activity has a status');
      }
      const note =
        patch.bodyMd === undefined ? referralNoteOf(current.bodyMd) : referralNoteOf(patch.bodyMd);
      patch.bodyMd = referralBody(referralStatus, note);
    }
    const row = await tx
      .update(activities)
      .set({ ...patch, updatedAt: Date.now() })
      .where(ownedActivity(ctx, id))
      .returning()
      .get();
    if (row === undefined) throw notFound();
    if (patch.title !== undefined || patch.bodyMd !== undefined) await indexActivity(tx, ctx, row);
    return row;
  });
}

export async function deleteActivity(db: Db, ctx: UserCtx, id: string): Promise<void> {
  await withTransaction(db, async (tx) => {
    const changes = await runCount(tx.delete(activities).where(ownedActivity(ctx, id)));
    if (changes === 0) throw notFound();
    await removeFromIndex(tx, ctx, 'activity', id);
  });
}

// ---------------------------------------------------------------------------
// Referral asks (FR-C4): 'referral' activities whose participants link a contact by id.

/** Referral activities of the caller that link `contactId` as a participant. */
function linksContact(contactId: string): SQL {
  return jsonArrayHasObjectWith(activities.participants, 'contactId', contactId);
}

function contactOf(participants: Participant[]): { contactId: string; name: string } | undefined {
  for (const p of participants) if (typeof p !== 'string') return p;
  return undefined;
}

/** Records a referral ask (status 'asked'); 404 for a contact or opportunity not the caller's. */
export async function createReferral(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
  input: { contactId: string; note?: string | null | undefined },
): Promise<ActivityRow> {
  return await withTransaction(db, async (tx) => {
    await assertOpportunityOwned(tx, ctx, opportunityId);
    const contact = await tx
      .select({ id: contacts.id, name: contacts.name })
      .from(contacts)
      .where(and(eq(contacts.userId, ctx.userId), eq(contacts.id, input.contactId)))
      .get();
    if (contact === undefined) throw notFound();
    const existing = await tx
      .select({ id: activities.id })
      .from(activities)
      .where(
        and(
          eq(activities.userId, ctx.userId),
          eq(activities.opportunityId, opportunityId),
          eq(activities.kind, 'referral'),
          linksContact(contact.id),
        ),
      )
      .get();
    if (existing !== undefined) throw duplicate(existing.id);
    const now = Date.now();
    const row = await tx
      .insert(activities)
      .values({
        id: newId(),
        userId: ctx.userId,
        opportunityId,
        kind: 'referral',
        title: `Referral ask: ${contact.name}`.slice(0, 300),
        bodyMd: referralBody('asked', input.note),
        occurredAt: now,
        participants: [{ contactId: contact.id, name: contact.name }],
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    await indexActivity(tx, ctx, row);
    return row;
  });
}

export interface OpportunityReferral {
  activityId: string;
  contactId: string;
  name: string;
  status: ReferralStatus | null;
  note: string | null;
  occurredAt: number;
}

/** The opportunity's referral asks linked to a contact, newest first. */
export async function listOpportunityReferrals(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
): Promise<Page<OpportunityReferral>> {
  await assertOpportunityOwned(db, ctx, opportunityId);
  const rows = await db
    .select()
    .from(activities)
    .where(
      and(
        eq(activities.userId, ctx.userId),
        eq(activities.opportunityId, opportunityId),
        eq(activities.kind, 'referral'),
      ),
    )
    .orderBy(desc(activities.occurredAt), desc(activities.id))
    .all();
  const items = rows.flatMap((r) => {
    const contact = contactOf(r.participants);
    return contact === undefined
      ? []
      : [
          {
            activityId: r.id,
            contactId: contact.contactId,
            name: contact.name,
            status: referralStatusOf(r.bodyMd),
            note: referralNoteOf(r.bodyMd),
            occurredAt: r.occurredAt,
          },
        ];
  });
  return { items, total: items.length };
}

export interface ContactReferral {
  activityId: string;
  opportunityId: string;
  opportunityTitle: string;
  companyName: string;
  status: ReferralStatus | null;
  occurredAt: number;
}

/** Every referral ask of the caller that links this contact, newest first. */
export async function listContactReferrals(
  exec: Exec,
  ctx: UserCtx,
  contactId: string,
): Promise<ContactReferral[]> {
  return (
    await exec
      .select({
        activityId: activities.id,
        opportunityId: activities.opportunityId,
        opportunityTitle: opportunities.title,
        companyName: companies.name,
        bodyMd: activities.bodyMd,
        occurredAt: activities.occurredAt,
      })
      .from(activities)
      .innerJoin(
        opportunities,
        and(eq(opportunities.id, activities.opportunityId), eq(opportunities.userId, ctx.userId)),
      )
      .innerJoin(companies, eq(companies.id, opportunities.companyId))
      .where(
        and(
          eq(activities.userId, ctx.userId),
          eq(activities.kind, 'referral'),
          linksContact(contactId),
        ),
      )
      .orderBy(desc(activities.occurredAt), desc(activities.id))
      .all()
  ).map(({ bodyMd, ...r }) => ({ ...r, status: referralStatusOf(bodyMd) }));
}

// ---------------------------------------------------------------------------
// Next steps

/** Undated steps sort after every dated one. */
const DUE_ORDER = sql`coalesce(${nextSteps.dueAt}, 9007199254740991)`;

export const NEXT_STEP_SORTS = sortColumns({
  dueAt: DUE_ORDER,
  createdAt: nextSteps.createdAt,
  updatedAt: nextSteps.updatedAt,
});

function ownedStep(ctx: UserCtx, id: string): SQL | undefined {
  return and(eq(nextSteps.userId, ctx.userId), eq(nextSteps.id, id));
}

export async function listNextSteps(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
  opts: ListOpts,
): Promise<Page<NextStepRow>> {
  await assertOpportunityOwned(db, ctx, opportunityId);
  const where = and(eq(nextSteps.userId, ctx.userId), eq(nextSteps.opportunityId, opportunityId));
  const items = await db
    .select()
    .from(nextSteps)
    .where(where)
    .orderBy(...orderBy(opts.sort, 'dueAt', NEXT_STEP_SORTS, nextSteps.id))
    .limit(opts.limit)
    .offset(opts.offset)
    .all();
  return { items, total: await countWhere(db, nextSteps, where) };
}

export async function createNextStep(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
  input: NextStepInput,
): Promise<NextStepRow> {
  return await withTransaction(db, async (tx) => {
    await assertOpportunityOwned(tx, ctx, opportunityId);
    const now = Date.now();
    return await tx
      .insert(nextSteps)
      .values({
        ...input,
        id: newId(),
        userId: ctx.userId,
        opportunityId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  });
}

export async function updateNextStep(
  db: Db,
  ctx: UserCtx,
  id: string,
  patch: Partial<NextStepInput>,
): Promise<NextStepRow> {
  const row = await db
    .update(nextSteps)
    .set({ ...patch, updatedAt: Date.now() })
    .where(ownedStep(ctx, id))
    .returning()
    .get();
  if (row === undefined) throw notFound();
  return row;
}

export async function deleteNextStep(db: Db, ctx: UserCtx, id: string): Promise<void> {
  const changes = await runCount(db.delete(nextSteps).where(ownedStep(ctx, id)));
  if (changes === 0) throw notFound();
}

// ---------------------------------------------------------------------------
// Timeline: one UNION ALL over every source, ordered and paged in SQLite.

interface TimelineBase {
  id: string;
  opportunityId: string;
  opportunityTitle: string;
  occurredAt: number;
}
export interface ActivityTimelineItem extends TimelineBase {
  kind: 'activity';
  activityKind: ActivityKind;
  title: string;
  bodyMd: string | null;
  participants: Participant[];
  externalUrl: string | null;
}
export interface StageTimelineItem extends TimelineBase {
  kind: 'stage';
  fromStage: OpportunityStage | null;
  toStage: OpportunityStage;
  note: string | null;
}
export interface CommunicationTimelineItem extends TimelineBase {
  kind: 'communication';
  channel: CommChannel;
  from: string;
  subject: string | null;
  snippet: string | null;
  classification: CommClassification | null;
}
export type TimelineItem = ActivityTimelineItem | StageTimelineItem | CommunicationTimelineItem;

/** Restricts a source to one user, and optionally to one opportunity. */
interface TimelineScope {
  userId: string;
  opportunityId?: string | undefined;
}

/**
 * Each source selects the same columns: kind (the discriminator), id, opportunity_id,
 * occurred_at, opportunity_title and data (a JSON object of kind-specific fields).
 * Communications linked to an opportunity are the third source (broadcast spam and irrelevant
 * outreach never are, see repos/communications).
 */
type TimelineSource = (scope: TimelineScope) => SQL;

const activitySource: TimelineSource = (scope) => sql`
  SELECT 'activity' AS kind, a.id AS id, a.opportunity_id AS opportunity_id,
         a.occurred_at AS occurred_at, o.title AS opportunity_title,
         ${jsonObject([
           ['activityKind', sql`a.kind`],
           ['title', sql`a.title`],
           ['bodyMd', sql`a.body_md`],
           ['participants', jsonValue(sql`a.participants`)],
           ['externalUrl', sql`a.external_url`],
         ])} AS data
  FROM activities a JOIN opportunities o ON o.id = a.opportunity_id AND o.user_id = a.user_id
  WHERE a.user_id = ${scope.userId}
  ${scope.opportunityId === undefined ? sql`` : sql`AND a.opportunity_id = ${scope.opportunityId}`}`;

const stageSource: TimelineSource = (scope) => sql`
  SELECT 'stage' AS kind, h.id AS id, h.opportunity_id AS opportunity_id,
         h.at AS occurred_at, o.title AS opportunity_title,
         ${jsonObject([
           ['fromStage', sql`h.from_stage`],
           ['toStage', sql`h.to_stage`],
           ['note', sql`h.note`],
         ])} AS data
  FROM stage_history h JOIN opportunities o ON o.id = h.opportunity_id AND o.user_id = h.user_id
  WHERE h.user_id = ${scope.userId}
  ${scope.opportunityId === undefined ? sql`` : sql`AND h.opportunity_id = ${scope.opportunityId}`}`;

const communicationSource: TimelineSource = (scope) => sql`
  SELECT 'communication' AS kind, c.id AS id, c.opportunity_id AS opportunity_id,
         c.sent_at AS occurred_at, o.title AS opportunity_title,
         ${jsonObject([
           ['channel', sql`c.channel`],
           ['from', sql`c."from"`],
           ['subject', sql`c.subject`],
           ['snippet', sql`c.snippet`],
           ['classification', sql`c.classification`],
         ])} AS data
  FROM communications c JOIN opportunities o ON o.id = c.opportunity_id AND o.user_id = c.user_id
  WHERE c.user_id = ${scope.userId}
    AND (c.outreach_kind IS NULL OR c.outreach_kind NOT IN ('broadcast_spam', 'irrelevant'))
  ${scope.opportunityId === undefined ? sql`` : sql`AND c.opportunity_id = ${scope.opportunityId}`}`;

const TIMELINE_SOURCES: readonly TimelineSource[] = [
  activitySource,
  stageSource,
  communicationSource,
];

interface TimelineRow {
  kind: TimelineItem['kind'];
  id: string;
  opportunity_id: string;
  occurred_at: number;
  opportunity_title: string;
  /** JSON text on SQLite, an already parsed object on Postgres: read through decodeJson. */
  data: unknown;
}

function timelineUnion(scope: TimelineScope): SQL {
  return sql.join(
    TIMELINE_SOURCES.map((source) => source(scope)),
    sql` UNION ALL `,
  );
}

function toItem(row: TimelineRow): TimelineItem {
  const base = {
    id: row.id,
    opportunityId: row.opportunity_id,
    opportunityTitle: row.opportunity_title,
    occurredAt: row.occurred_at,
  };
  // data is built by jsonObject in the source query above, so its shape is known.
  const data = decodeJson(row.data);
  if (row.kind === 'activity') {
    return {
      ...base,
      kind: 'activity',
      ...(data as Omit<ActivityTimelineItem, keyof TimelineBase | 'kind'>),
    };
  }
  if (row.kind === 'communication') {
    return {
      ...base,
      kind: 'communication',
      ...(data as Omit<CommunicationTimelineItem, keyof TimelineBase | 'kind'>),
    };
  }
  return {
    ...base,
    kind: 'stage',
    ...(data as Omit<StageTimelineItem, keyof TimelineBase | 'kind'>),
  };
}

async function timeline(
  exec: Exec,
  scope: TimelineScope,
  page: { limit: number; offset: number },
): Promise<Page<TimelineItem>> {
  const union = timelineUnion(scope);
  const rows = await rawAll<TimelineRow>(
    exec,
    // The derived table needs an alias on Postgres (SQLite accepts one too).
    sql`SELECT * FROM (${union}) AS timeline ORDER BY occurred_at DESC, id DESC LIMIT ${page.limit} OFFSET ${page.offset}`,
  );
  const total = Number(
    (
      await rawGet<{ n: number | string }>(
        exec,
        sql`SELECT count(*) AS n FROM (${union}) AS timeline`,
      )
    )?.n ?? 0,
  );
  return { items: rows.map(toItem), total };
}

export async function opportunityTimeline(
  db: Db,
  ctx: UserCtx,
  opportunityId: string,
  page: { limit: number; offset: number },
): Promise<Page<TimelineItem>> {
  await assertOpportunityOwned(db, ctx, opportunityId);
  return await timeline(db, { userId: ctx.userId, opportunityId }, page);
}

// ---------------------------------------------------------------------------
// Dashboard

export const DUE_WINDOW_MS = 7 * 86_400_000;
const RECENT_ACTIVITY = 10;
const MAX_DUE_STEPS = 50;

export type DueNextStep = NextStepRow & { opportunityTitle: string; companyName: string };

const TERMINAL_STAGES: OpportunityStage[] = ['closed', 'dismissed'];

export interface Dashboard {
  stageCounts: Record<OpportunityStage, number>;
  dueNextSteps: DueNextStep[];
  recentActivity: TimelineItem[];
  needsTriage: { communications: number };
}

export async function dashboard(db: Db, ctx: UserCtx, now = Date.now()): Promise<Dashboard> {
  const grouped = await db
    .select({ stage: opportunities.stage, n: count() })
    .from(opportunities)
    .where(eq(opportunities.userId, ctx.userId))
    .groupBy(opportunities.stage)
    .all();
  const byStage = new Map(grouped.map(({ stage, n }) => [stage, n]));
  // Every stage is present, zero when the caller has none in it.
  const stageCounts = Object.fromEntries(
    OPPORTUNITY_STAGES.map((s) => [s, byStage.get(s) ?? 0]),
  ) as Record<OpportunityStage, number>;

  // Overdue steps count as due: "due within 7 days" means due on or before now + 7d.
  // Steps on closed or dismissed opportunities are moot and never surface here.
  const dueNextSteps = await db
    .select({
      id: nextSteps.id,
      userId: nextSteps.userId,
      opportunityId: nextSteps.opportunityId,
      action: nextSteps.action,
      dueAt: nextSteps.dueAt,
      doneAt: nextSteps.doneAt,
      owner: nextSteps.owner,
      createdAt: nextSteps.createdAt,
      updatedAt: nextSteps.updatedAt,
      opportunityTitle: opportunities.title,
      companyName: companies.name,
    })
    .from(nextSteps)
    .innerJoin(
      opportunities,
      and(eq(opportunities.id, nextSteps.opportunityId), eq(opportunities.userId, ctx.userId)),
    )
    .innerJoin(companies, eq(companies.id, opportunities.companyId))
    .where(
      and(
        eq(nextSteps.userId, ctx.userId),
        isNull(nextSteps.doneAt),
        isNotNull(nextSteps.dueAt),
        lte(nextSteps.dueAt, now + DUE_WINDOW_MS),
        notInArray(opportunities.stage, TERMINAL_STAGES),
      ),
    )
    .orderBy(asc(nextSteps.dueAt), asc(nextSteps.id))
    .limit(MAX_DUE_STEPS)
    .all();

  const recentActivity = (
    await timeline(db, { userId: ctx.userId }, { limit: RECENT_ACTIVITY, offset: 0 })
  ).items;

  // The Inbox "Needs review" view: flagged messages that are not spam or irrelevant outreach.
  const triage = await countWhere(
    db,
    communications,
    and(
      eq(communications.userId, ctx.userId),
      eq(communications.needsReview, true),
      or(
        isNull(communications.outreachKind),
        notInArray(communications.outreachKind, ['broadcast_spam', 'irrelevant']),
      ),
    ),
  );

  return { stageCounts, dueNextSteps, recentActivity, needsTriage: { communications: triage } };
}
