// What both schema twins share (ADR-4): enum value lists, JSON payload types and the table
// list. schema.sqlite.ts and schema.pg.ts each import from here, so an enum or payload type
// can only change in one place; db/schema.ts re-exports all of it for the repos.

export const SESSION_KINDS = ['session', 'pending_2fa'] as const;

/** Scopes a device token may carry (FR-M5, FR-C5). */
export const DEVICE_TOKEN_SCOPES = ['mail:push', 'capture:push'] as const;
export type DeviceTokenScope = (typeof DEVICE_TOKEN_SCOPES)[number];

export const SECRET_KINDS = ['ai_api_key', 'oauth_token', 'device_token'] as const;

export interface ProfileLinkRow {
  label: string;
  url: string;
}

export interface TranscriptTurn {
  role: 'user' | 'assistant';
  content: string;
  at: number;
  /** Find/replace suggestions parsed from an assistant reply's fenced json block. */
  edits?: { find: string; replace: string; rationale?: string }[];
  /** An assistant reply still streaming, or cut off by a provider failure. */
  incomplete?: boolean;
}

/** The resume.match AI task's output (packages/ai/src/tasks.ts MatchReportSchema). */
export interface MatchReport {
  score: number;
  missingKeywords: string[];
  weakAreas: { area: string; suggestion: string }[];
  summary: string;
}

/**
 * One ATS job reference extracted from a message body at ingest (design D-5).
 *
 * Structurally `AtsJobRef` from lib/atsJobRef, declared here because the schema twins cannot
 * import from lib, and with `kind` widened to string: a row may have been written by another
 * version of the app, so the reader validates the kind rather than trusting the column.
 */
export interface AtsJobRefRecord {
  kind: string;
  org: string | null;
  host?: string;
  externalPath?: string;
  externalId: string;
  url: string;
}

export const DISCOVERY_SOURCE_STATUSES = ['ok', 'error'] as const;
export const FEEDBACK_KINDS = ['dismissal', 'classification', 'rejection'] as const;

/**
 * Why a message or lead should never have been in scope (spec D4). A closed vocabulary
 * because only the CODE reaches the prompt-refinement model; the free-text note beside it
 * stays local unless the user opts that one note in.
 */
export const REJECTION_REASONS = [
  'not_job_related',
  'medical_or_personal',
  'financial',
  'wrong_role',
  'wrong_company',
  'spam',
  'other',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

/** What a mail filter rule does, and at which spec D1 rule it is evaluated. */
export const MAIL_FILTER_EFFECTS = ['allow', 'deny', 'job_sender'] as const;
export type MailFilterEffect = (typeof MAIL_FILTER_EFFECTS)[number];
/** Where a rule came from, so seeds and rejection-added entries stay auditable. */
export const MAIL_FILTER_SOURCES = ['seed', 'user', 'rejection'] as const;
export type MailFilterSource = (typeof MAIL_FILTER_SOURCES)[number];
export const TASK_RUN_STATUSES = ['ok', 'error'] as const;
export const CONTACT_SOURCES = ['manual', 'linkedin_export', 'capture'] as const;
export const JOB_STATUSES = ['pending', 'running', 'done', 'dead'] as const;

/** issue #94: a near-miss pair the heuristic (and later the AI pass) has or hasn't ruled on.
 *  'pending' is never shown to the user directly: only a 'confirmed' pair is surfaced, via the
 *  existing opportunities.possible_duplicate_of column. */
export const DEDUPE_CANDIDATE_DECISIONS = ['pending', 'confirmed', 'rejected'] as const;
export type DedupeCandidateDecision = (typeof DEDUPE_CANDIDATE_DECISIONS)[number];
/** Who made a non-pending decision: the cheap heuristic, the AI second pass, or the user via
 *  dismiss-duplicate. Null while a pair is still 'pending'. */
export const DEDUPE_CANDIDATE_DECIDED_BY = ['heuristic', 'ai', 'user'] as const;
export type DedupeCandidateDecidedBy = (typeof DEDUPE_CANDIDATE_DECIDED_BY)[number];

/**
 * Every table both twins define, by export name. The FTS5 `search_index` is not here: it is
 * a SQLite virtual table outside the Drizzle schema, and its Postgres twin is Task 11's.
 */
export const TABLE_EXPORTS = [
  'users',
  'sessions',
  'deviceTokens',
  'oauthAccounts',
  'secrets',
  'auditLog',
  'prompts',
  'profiles',
  'roleTargets',
  'resumeRules',
  'companies',
  'opportunities',
  'opportunityDedupeCandidates',
  'stageHistory',
  'activities',
  'nextSteps',
  'attachments',
  'resumes',
  'tailoringSessions',
  'resumeMatchReports',
  'discoverySources',
  'discoveryRuns',
  'discoveryResults',
  'dismissalFeedback',
  'mailFilterRules',
  'taskRuns',
  'contacts',
  'communications',
  'syncState',
  'jobs',
  'settings',
] as const;
export type TableExport = (typeof TABLE_EXPORTS)[number];
