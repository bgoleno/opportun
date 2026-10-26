// Client-side types, labels and calls for opportunities and their lifecycle. Shapes
// mirror the /api/v1 responses (apps/server/src/routes/opportunities.ts, activities.ts).
import {
  canTransition,
  OPPORTUNITY_STAGES,
  type ActivityKind,
  type ClosedReason,
  type CommChannel,
  type CommClassification,
  type DismissReason,
  type NextStep,
  type Opportunity,
  type OpportunityStage,
  type Participant,
  type SourceKind,
} from '@opportun/core';
import { api } from './api';

export type OpportunityView = Opportunity & {
  companyName: string;
  /** Null until a homepage is confidently resolved (issue #239); never a guess, so never
   *  rendered as a link until then. */
  companyDomain: string | null;
  /** Ids of opportunities this one is flagged as a possible duplicate with (#9), from either
   *  direction. Empty when there is nothing to badge. */
  possibleDuplicates: string[];
  /** True when the description is the user's own writing (issue #255), not the system's. */
  descriptionIsUserWritten: boolean;
  /** True when a 'capture' activity exists on this opportunity's timeline (issue #264), so a
   *  description can be re-derived from it. */
  hasCapturedPage: boolean;
};

/** Whether the pipeline card should carry the possible-duplicate badge. */
export function hasPossibleDuplicate(opp: OpportunityView): boolean {
  return opp.possibleDuplicates.length > 0;
}

export interface Page<T> {
  items: T[];
  total: number;
}

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

export type DueNextStep = NextStep & { opportunityTitle: string; companyName: string };

export interface DashboardData {
  stageCounts: Record<OpportunityStage, number>;
  dueNextSteps: DueNextStep[];
  recentActivity: TimelineItem[];
  needsTriage: { communications: number };
}

export interface AttachmentMeta {
  id: string;
  opportunityId: string | null;
  filename: string;
  mime: string;
  bytes: number;
  createdAt: number;
}

const STAGE_LABELS = new Map<OpportunityStage, string>([
  // Label only, not the stored 'discovered' value (issue #201): "Discovery" the section and
  // "Discovered" the stage read as the same thing and are not, and the collision is what
  // prompted the question this issue exists to answer. "New" is the recommendation on the
  // issue, with the owner deciding; it costs one word here to pick something else.
  ['discovered', 'New'],
  ['interested', 'Interested'],
  ['preparing', 'Preparing'],
  ['applied', 'Applied'],
  ['in_process', 'In process'],
  ['offer', 'Offer'],
  ['dismissed', 'Dismissed'],
  ['closed', 'Closed'],
]);

/** Where an opportunity came from (issue #201): a quiet orienting fact, not a judgment. Most
 *  of a real board's "New" column was never clicked into existence (an inbox message that
 *  looked like a targeted solicitation), so the label says what happened, not who did it. */
const SOURCE_LABELS = new Map<SourceKind, string>([
  ['manual', 'Added manually'],
  ['import', 'Imported'],
  ['discovery', 'Discovery'],
  ['communication', 'From a message'],
]);

const CLOSED_REASON_LABELS = new Map<ClosedReason, string>([
  ['accepted', 'Accepted'],
  ['rejected', 'Rejected'],
  ['withdrawn', 'Withdrawn'],
  ['ghosted', 'Ghosted'],
]);

const DISMISS_REASON_LABELS = new Map<DismissReason, string>([
  ['seniority', 'Seniority'],
  ['compensation', 'Compensation'],
  ['location', 'Location'],
  ['industry', 'Industry'],
  // Not "Role": every row here is a role, so the bare word reads as "it's a role" rather
  // than "the role itself is wrong," right where it sits next to Seniority and Industry,
  // two WAYS a role can be wrong, not the role's own nature (#159).
  ['role_fit', 'Role fit'],
  ['company', 'Company'],
  ['stale', 'Stale'],
  ['not_interested', 'Not interested'],
  ['duplicate', 'Duplicate'],
  ['other', 'Other'],
  ['denied_company', 'Denied company'],
]);

const PRIORITY_LABELS = new Map<number, string>([
  [1, 'High'],
  [2, 'Normal'],
  [3, 'Low'],
]);

const ACTIVITY_KIND_LABELS = new Map<ActivityKind, string>([
  ['note', 'Note'],
  ['meeting', 'Meeting'],
  ['interview', 'Interview'],
  ['application', 'Application'],
  ['message_ref', 'Message'],
  ['stage_change', 'Stage change'],
  ['referral', 'Referral'],
  ['link', 'Link'],
  ['capture', 'Captured page'],
]);

export const activityKindLabel = (k: ActivityKind): string => ACTIVITY_KIND_LABELS.get(k) ?? k;
export const stageLabel = (s: OpportunityStage): string => STAGE_LABELS.get(s) ?? s;
export const sourceKindLabel = (s: SourceKind): string => SOURCE_LABELS.get(s) ?? s;
export const closedReasonLabel = (r: ClosedReason): string => CLOSED_REASON_LABELS.get(r) ?? r;
export const dismissReasonLabel = (r: DismissReason): string => DISMISS_REASON_LABELS.get(r) ?? r;
export const priorityLabel = (p: number): string => PRIORITY_LABELS.get(p) ?? String(p);

export function isTerminal(stage: OpportunityStage): boolean {
  return stage === 'dismissed' || stage === 'closed';
}

/** The lifecycle chain (every stage that is not closed or dismissed), in order. */
export const CHAIN_STAGES: readonly OpportunityStage[] = OPPORTUNITY_STAGES.filter(
  (s) => !isTerminal(s),
);

/**
 * Targets a normal stage control may offer: the core state machine's valid moves, minus
 * moves out of closed or dismissed, which the server only accepts as an explicit reopen.
 */
export function stageTargets(from: OpportunityStage): OpportunityStage[] {
  return OPPORTUNITY_STAGES.filter(
    (to) => canTransition(from, to) && !(isTerminal(from) && !isTerminal(to)),
  );
}

/** Targets the separate "Reopen" action offers (empty unless closed or dismissed). */
export function reopenTargets(from: OpportunityStage): OpportunityStage[] {
  return isTerminal(from) ? CHAIN_STAGES.filter((to) => canTransition(from, to)) : [];
}

export interface StageChange {
  to: OpportunityStage;
  closedReason?: ClosedReason;
  dismissedReason?: DismissReason;
  note?: string;
  reopen?: boolean;
}

export function changeStage(id: string, body: StageChange): Promise<OpportunityView> {
  return api<OpportunityView>(`/opportunities/${encodeURIComponent(id)}/stage`, {
    method: 'POST',
    body,
  });
}

export function setNextStepDone(id: string, done: boolean): Promise<NextStep> {
  return api<NextStep>(`/next-steps/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { done },
  });
}

/** Query keys. Everything opportunity-shaped hangs under ['opportunities'] or ['opportunity']. */
export const qk = {
  dashboard: ['dashboard'] as const,
  opportunities: ['opportunities'] as const,
  opportunityList: (params: Record<string, string | number | undefined>) =>
    ['opportunities', params] as const,
  opportunity: (id: string) => ['opportunity', id] as const,
  timeline: (id: string) => ['opportunity', id, 'timeline'] as const,
  nextSteps: (id: string) => ['opportunity', id, 'next-steps'] as const,
  attachments: (id: string) => ['opportunity', id, 'attachments'] as const,
};

const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function formatDate(ms: number): string {
  return dateFmt.format(ms);
}

export function formatDateTime(ms: number): string {
  return dateTimeFmt.format(ms);
}

/** One line describing a timeline entry, e.g. "Applied to In process" or an activity title. */
export function timelineSummary(item: TimelineItem): string {
  if (item.kind === 'activity') return item.title;
  if (item.kind === 'communication') return item.subject?.trim() || `Message from ${item.from}`;
  const to = stageLabel(item.toStage);
  return item.fromStage === null ? `Created in ${to}` : `${stageLabel(item.fromStage)} to ${to}`;
}

/** The URL if it is http(s), else null: only those are ever rendered as links. */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * A company's homepage URL from its stored bare domain (e.g. "example.com"), or null when none
 * is resolved yet (issue #239). Still passed through safeHttpUrl: companies.domain is written
 * only by code this app controls, but an href is never rendered without that check regardless,
 * the same defense-in-depth every other link in this file gets.
 */
export function companyHomepageUrl(domain: string | null | undefined): string | null {
  return domain ? safeHttpUrl(`https://${domain}`) : null;
}

/** "2048" -> "2 KB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** A yyyy-mm-dd date input value as the end of that local day, in epoch ms. */
export function endOfLocalDay(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m === null) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}
