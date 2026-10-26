import { z } from 'zod';
import { COMPANY_STATUSES, IdSchema, TimestampSchema } from './common';

export const OPPORTUNITY_STAGES = [
  'discovered',
  'interested',
  'preparing',
  'applied',
  'in_process',
  'offer',
  'dismissed',
  'closed',
] as const;
export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

/**
 * Stages that count as "in the pipeline" for issue #239 (link the company name to its
 * homepage): past the raw, unactioned 'discovered' inbox, short of a terminal exit
 * ('dismissed'/'closed', where resolving a homepage buys nothing). Shared between the
 * stage-transition trigger (repos/opportunities.ts) and the one-shot backfill
 * (jobs/companyDomainResolve.ts) so the two can never quietly disagree about what "entering
 * the pipeline" means.
 */
export const ACTIVE_PIPELINE_STAGES = [
  'interested',
  'preparing',
  'applied',
  'in_process',
  'offer',
] as const satisfies readonly OpportunityStage[];

export const CLOSED_REASONS = ['accepted', 'rejected', 'withdrawn', 'ghosted'] as const;
export type ClosedReason = (typeof CLOSED_REASONS)[number];

export const DISMISS_REASONS = [
  'seniority',
  'compensation',
  'location',
  'industry',
  /**
   * The role itself (function/domain) is not one the user does, not an attribute OF a role
   * they'd otherwise take (#159). Deliberately distinct from `industry`: a security product
   * role at a security SaaS company is wrong on this axis even when the industry is a fit,
   * and collapsing the two would teach discovery to avoid the industry instead of the role.
   */
  'role_fit',
  'company',
  'stale',
  /**
   * Bulk dismiss's own reason (#184): a batch triage decision that carries no information
   * about which axis was wrong, unlike every other reason here. Deliberately excluded from
   * refineDiscoveryPrompt's feedback count (jobs/refineDiscoveryPrompt.ts) for that reason;
   * see the comment there before changing this list's meaning.
   */
  'not_interested',
  /**
   * The posting is a duplicate of one already tracked (dedupe missed it, #184/#191): this
   * is not a judgment about the role at all, and it is worse than carrying no axis, since
   * it carries a MISLEADING one. Counting it as dismissal feedback would teach the scoring
   * prompt that the user doesn't want this kind of role, when the actual complaint is "you
   * showed me this twice." That is the opposite of what the user is saying. Excluded from
   * refineDiscoveryPrompt's feedback count for that reason, same as `not_interested`; see
   * the comment there before changing this list's meaning.
   */
  'duplicate',
  'other',
  /**
   * Issue #199: the system auto-suppressed a posting because its company is on the user's own
   * denylist, not a one-off human judgment about this particular posting -- never offered as a
   * choice in the per-item dismiss dialog (that dialog only reaches a posting that was never
   * denylist-matched in the first place). Distinct from `company` (a human decided, reviewing
   * one posting, that something about the company was wrong for them, which IS informative
   * about role fit): this carries no new information once the denylist itself exists, the same
   * way `duplicate` is a misleading signal about a different subsystem rather than an absence
   * of one. See REASONS_EXCLUDED_FROM_REFINEMENT in refineDiscoveryPrompt.ts.
   */
  'denied_company',
] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];

export const SOURCE_KINDS = ['manual', 'import', 'discovery', 'communication'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * How far the search for an opportunity's posting on the company's own ATS board has got
 * (design D17). Null means no search was ever attempted, which is the state of every
 * opportunity created by hand.
 */
export const POSTING_STATES = ['searching', 'confirmed', 'needs_review'] as const;
export type PostingState = (typeof POSTING_STATES)[number];

/**
 * Why a posting needs review, or why a `confirmed` one isn't a board match (issue #250): every
 * value but one is set only beside `needs_review`.
 */
export const POSTING_STATE_DETAILS = [
  'ambiguous',
  'none_found',
  'no_board',
  'edited',
  /** The board check did not finish. Never leave an opportunity on `searching` instead. */
  'failed',
  /** The one exception: set beside `confirmed`, never `needs_review`. The user looked and said
   *  this posting is right as it stands, which is a different fact from a board match -- the
   *  posting URL may be a third-party listing they vouched for, not the employer's own page. */
  'user_confirmed',
] as const;
export type PostingStateDetail = (typeof POSTING_STATE_DETAILS)[number];

/** The ATS boards a posting can be addressed on (the server's AtsKind, which is a subset of
 *  DISCOVERY_SOURCE_KINDS; kept here so the stored shape is typed without importing it). */
export const ATS_REF_KINDS = ['ats_greenhouse', 'ats_lever', 'ats_ashby', 'ats_workday'] as const;

/**
 * Which req on which board this opportunity is, so a later apply path can address it rather
 * than re-deriving it from a URL (design D16). Structurally the server's `AtsJobRef`.
 */
export const AtsJobRefSchema = z.object({
  kind: z.enum(ATS_REF_KINDS),
  /** The board slug (Workday: `<tenant>/<site>`); null for a `gh_jid` link on a company domain. */
  org: z.string().max(200).nullable(),
  /** Workday only: the tenant's host. */
  host: z.string().max(300).optional(),
  /** Workday only: the posting's CXS path. */
  externalPath: z.string().max(500).optional(),
  externalId: z.string().min(1).max(200),
  url: z.string().max(2000),
});
export type AtsJobRef = z.infer<typeof AtsJobRefSchema>;

export const CompanySchema = z.object({
  id: IdSchema,
  userId: IdSchema,
  name: z.string().min(1),
  domain: z.string().nullish(),
  careersUrl: z.url().nullish(),
  status: z.enum(COMPANY_STATUSES).default('none'),
  suggestionRationale: z.string().nullish(),
  atsKind: z.string().nullish(),
  atsRef: z.string().nullish(),
  atsVerifiedAt: TimestampSchema.nullish(),
  notes: z.string().nullish(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Company = z.infer<typeof CompanySchema>;

export const OpportunitySchema = z.object({
  id: IdSchema,
  userId: IdSchema,
  companyId: IdSchema,
  roleTargetId: IdSchema.nullish(),
  title: z.string().min(1),
  descriptionMd: z.string().nullish(),
  postingUrl: z.url().nullish(),
  sourceKind: z.enum(SOURCE_KINDS),
  sourceRef: z.string().nullish(),
  location: z.string().nullish(),
  remote: z.boolean().nullish(),
  compNote: z.string().nullish(),
  stage: z.enum(OPPORTUNITY_STAGES),
  /** Free-form round label within a stage, e.g. "onsite loop". */
  stageDetail: z.string().nullish(),
  closedReason: z.enum(CLOSED_REASONS).nullish(),
  dismissedReason: z.enum(DISMISS_REASONS).nullish(),
  priority: z.number().int().min(1).max(3).default(2),
  /** Manual position within a stage (issue #240): independent of `priority`, which stays a
   *  display badge only. Lower sorts first; server-assigned on create and stage change. */
  sortOrder: z.number().int().default(0),
  /** Which req on which ATS board this is, once a board search confirmed it (D16). */
  atsJobRef: AtsJobRefSchema.nullish(),
  /** How far the board search got (D17), and why it needs review when it does. */
  postingState: z.enum(POSTING_STATES).nullish(),
  postingStateDetail: z.enum(POSTING_STATE_DETAILS).nullish(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Opportunity = z.infer<typeof OpportunitySchema>;

export const ACTIVITY_KINDS = [
  'note',
  'meeting',
  'interview',
  'application',
  'message_ref',
  'stage_change',
  'referral',
  'link',
  /** The page text the browser extension captured, kept whole (design D12). */
  'capture',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/**
 * Someone on an activity: a free-text name, or a linked contact (referral asks, FR-C4). The
 * name is kept with the link so the timeline still reads after the contact is deleted.
 */
export const ParticipantSchema = z.union([
  z.string(),
  z.object({ contactId: z.string().min(1), name: z.string() }),
]);
export type Participant = z.infer<typeof ParticipantSchema>;

/** Display name of a participant. */
export function participantName(p: Participant): string {
  return typeof p === 'string' ? p : p.name;
}

/** Where a referral ask stands (FR-C4); kept as the first line of the activity body. */
export const REFERRAL_STATUSES = ['asked', 'agreed', 'submitted', 'declined'] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

const STATUS_LINE = /^Status: (asked|agreed|submitted|declined)[ \t]*(?:\r?\n|$)/;

/** The status a referral activity body records, or null when it has none. */
export function referralStatusOf(bodyMd: string | null | undefined): ReferralStatus | null {
  const m = STATUS_LINE.exec(bodyMd ?? '');
  return m === null ? null : (m[1] as ReferralStatus);
}

/** The body's text after the status line (the ask's note), or null when empty. */
export function referralNoteOf(bodyMd: string | null | undefined): string | null {
  const rest = (bodyMd ?? '').replace(STATUS_LINE, '').trim();
  return rest === '' ? null : rest;
}

/** A referral body: the status line, then the note. */
export function referralBody(status: ReferralStatus, note: string | null | undefined): string {
  const text = (note ?? '').trim();
  return text === '' ? `Status: ${status}` : `Status: ${status}\n\n${text}`;
}

export const ActivitySchema = z.object({
  id: IdSchema,
  userId: IdSchema,
  opportunityId: IdSchema,
  kind: z.enum(ACTIVITY_KINDS),
  title: z.string().min(1),
  bodyMd: z.string().nullish(),
  occurredAt: TimestampSchema,
  participants: z.array(ParticipantSchema).default([]),
  externalUrl: z.url().nullish(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Activity = z.infer<typeof ActivitySchema>;

export const NextStepSchema = z.object({
  id: IdSchema,
  userId: IdSchema,
  opportunityId: IdSchema,
  action: z.string().min(1),
  dueAt: TimestampSchema.nullish(),
  doneAt: TimestampSchema.nullish(),
  owner: z.string().nullish(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type NextStep = z.infer<typeof NextStepSchema>;
