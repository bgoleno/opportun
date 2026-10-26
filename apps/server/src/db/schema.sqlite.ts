// Database schema, SQLite dialect (design section 4, plus jobs from section 8 and settings).
// Conventions: ids are UUIDv7 TEXT, times are epoch ms INTEGER, JSON is TEXT.
// Every table holding one user's data carries user_id NOT NULL with an index (FR-S5).
// The Postgres twin is schema.pg.ts (same tables, columns, indexes and row types, pinned by
// test/schemaConformance.test.ts); repos import tables from db/schema, which picks the twin
// matching DB_DIALECT. Enums and JSON payload types shared by both live in schema.shared.ts.
import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import {
  ACTIVITY_KINDS,
  BODY_SOURCES,
  CLOSED_REASONS,
  COMM_CHANNELS,
  COMM_CLASSIFICATIONS,
  COMPANY_STATUSES,
  DISCOVERY_SOURCE_KINDS,
  DISMISS_REASONS,
  DISPOSITIONS,
  OPPORTUNITY_STAGES,
  OUTREACH_KINDS,
  POSTING_STATE_DETAILS,
  POSTING_STATES,
  REMOTE_PREFS,
  RESOLUTIONS,
  RESUME_KINDS,
  RESUME_RULE_CATEGORIES,
  RESUME_STATUSES,
  RESUME_STORES,
  SOURCE_KINDS,
  type AtsJobRef,
  type Participant,
} from '@opportun/core';
import {
  type AtsJobRefRecord,
  CONTACT_SOURCES,
  DEDUPE_CANDIDATE_DECIDED_BY,
  DEDUPE_CANDIDATE_DECISIONS,
  type DeviceTokenScope,
  DISCOVERY_SOURCE_STATUSES,
  FEEDBACK_KINDS,
  JOB_STATUSES,
  MAIL_FILTER_EFFECTS,
  MAIL_FILTER_SOURCES,
  type MatchReport,
  type ProfileLinkRow,
  REJECTION_REASONS,
  SECRET_KINDS,
  SESSION_KINDS,
  TASK_RUN_STATUSES,
  type TranscriptTurn,
} from './schema.shared';

const id = () => text('id').primaryKey();
const createdAt = () => integer('created_at').notNull();
const updatedAt = () => integer('updated_at').notNull();
const userRef = () =>
  text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' });
const bool = (name: string) => integer(name, { mode: 'boolean' });
const json = <T>(name: string) => text(name, { mode: 'json' }).$type<T>();

// ---------------------------------------------------------------------------
// 4.1 Identity and access

export const users = sqliteTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  isAdmin: bool('is_admin').notNull().default(false),
  /**
   * Vault-encrypted (secretBox encryptSecret) TOTP secret, never plaintext. Set at enrollment
   * (pending while totp_enabled is false); null when 2FA is off.
   */
  totpSecret: text('totp_secret'),
  /** True once the user proved the enrolled secret with a code (FR-S3). */
  totpEnabled: bool('totp_enabled').notNull().default(false),
  /** SHA-256 hex of each unused recovery code (JSON array); null when 2FA is off. */
  totpRecovery: json<string[]>('totp_recovery'),
  /** Last TOTP time step accepted: a code is never accepted twice (replay guard). */
  totpLastStep: integer('totp_last_step'),
  /**
   * When this user was last known to be signed in (issue #320): null until their first
   * sign-in, never cleared on sign-out (that is the bug #320 fixes -- see createSession and
   * getSessionUser in lib/sessions.ts for the two writers). Accurate to within
   * TOUCH_INTERVAL_MS (currently 60s) while a session is active, not to the second: it is
   * "last known," not a precise activity log.
   */
  lastSeenAt: integer('last_seen_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    /** SHA-256 hex of the opaque token; the token itself is never stored. */
    id: text('id').primaryKey(),
    userId: userRef(),
    /** Absolute expiry. */
    expiresAt: integer('expires_at').notNull(),
    /** Drives the sliding idle expiry. */
    lastSeenAt: integer('last_seen_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    /**
     * 'session' is a signed-in session; 'pending_2fa' is the short-lived, single-use proof that
     * the password step passed, which only POST /auth/2fa/verify accepts (never as a cookie).
     */
    kind: text('kind', { enum: SESSION_KINDS }).notNull().default('session'),
    /** pending_2fa only: wrong codes so far; the row is deleted at MAX_PENDING_FAILURES. */
    failedAttempts: integer('failed_attempts').notNull().default(0),
    /** pending_2fa only: when the token was redeemed (a replay then reads token_used). */
    usedAt: integer('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);

/**
 * Bearer tokens for non-browser clients (the Apple Mail connector, the capture extension).
 * Only routes that opt in with requireDeviceToken accept them; they never act as a session.
 */
export const deviceTokens = sqliteTable(
  'device_tokens',
  {
    id: id(),
    userId: userRef(),
    name: text('name').notNull(),
    /** SHA-256 hex of the token; the token itself is shown once and never stored. */
    tokenHash: text('token_hash').notNull().unique(),
    scopes: json<DeviceTokenScope[]>('scopes').notNull(),
    lastUsedAt: integer('last_used_at'),
    /** Set on revoke; a revoked token fails on its very next request. */
    revokedAt: integer('revoked_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('device_tokens_user_id_idx').on(t.userId)],
);

/** M5 OAuth sign-in accounts. */
export const oauthAccounts = sqliteTable(
  'oauth_accounts',
  {
    id: id(),
    userId: userRef(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    /** Encrypted token bundle (secretBox). */
    tokens: text('tokens'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('oauth_accounts_user_id_idx').on(t.userId),
    uniqueIndex('oauth_accounts_provider_account_uq').on(t.provider, t.providerAccountId),
  ],
);

export const secrets = sqliteTable(
  'secrets',
  {
    id: id(),
    userId: userRef(),
    kind: text('kind', { enum: SECRET_KINDS }).notNull(),
    label: text('label').notNull(),
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    tag: text('tag').notNull(),
    keyVersion: integer('key_version').notNull(),
    /** User-entered name (e.g. the key's name in the provider console); label stays the provider id. */
    displayName: text('display_name'),
    /** User-entered expiry (epoch ms). Providers expose no key expiry, so only the user knows it. */
    expiresAt: integer('expires_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('secrets_user_id_idx').on(t.userId)],
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: id(),
    /** Null for events without an authenticated user (e.g. failed login). */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    event: text('event').notNull(),
    /** Pre-redacted detail. */
    detail: json<Record<string, unknown>>('detail'),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_log_user_id_idx').on(t.userId),
    index('audit_log_created_at_idx').on(t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// 4.5 (prompts first: role_targets references it)

export const prompts = sqliteTable(
  'prompts',
  {
    id: id(),
    /** Null for seeded system defaults. */
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    taskKey: text('task_key').notNull(),
    name: text('name').notNull(),
    body: text('body').notNull(),
    version: integer('version').notNull(),
    parentId: text('parent_id').references((): AnySQLiteColumn => prompts.id, {
      onDelete: 'set null',
    }),
    isActive: bool('is_active').notNull().default(false),
    /**
     * A refinement the app proposed from the user's corrections (FR-D6 pattern). Always created
     * inactive; only the user's accept activates it (and clears the flag).
     */
    proposed: bool('proposed').notNull().default(false),
    /** The proposer's explanation of the change, shown next to the diff. */
    proposalSummary: text('proposal_summary'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('prompts_user_id_idx').on(t.userId),
    uniqueIndex('prompts_task_version_user_uq').on(t.taskKey, t.version, t.userId),
    // SQLite treats NULLs as distinct in unique indexes; system defaults need their own.
    uniqueIndex('prompts_task_version_system_uq')
      .on(t.taskKey, t.version)
      .where(sql`${t.userId} IS NULL`),
  ],
);

// ---------------------------------------------------------------------------
// 4.2 Profile

export const profiles = sqliteTable('profiles', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  fullName: text('full_name'),
  headline: text('headline'),
  email: text('email'),
  phone: text('phone'),
  location: text('location'),
  workAuth: text('work_auth'),
  links: json<ProfileLinkRow[]>('links').notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const roleTargets = sqliteTable(
  'role_targets',
  {
    id: id(),
    userId: userRef(),
    name: text('name').notNull(),
    titleFamily: text('title_family').notNull(),
    seniorityMin: integer('seniority_min'),
    seniorityMax: integer('seniority_max'),
    industries: json<string[]>('industries').notNull().default([]),
    keywords: json<string[]>('keywords').notNull().default([]),
    locations: json<string[]>('locations').notNull().default([]),
    remotePref: text('remote_pref', { enum: REMOTE_PREFS }).notNull().default('any'),
    compMin: integer('comp_min'),
    compMax: integer('comp_max'),
    currency: text('currency'),
    active: bool('active').notNull().default(true),
    discoveryPromptId: text('discovery_prompt_id').references(() => prompts.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('role_targets_user_id_idx').on(t.userId)],
);

export const resumeRules = sqliteTable(
  'resume_rules',
  {
    id: id(),
    userId: userRef(),
    ruleText: text('rule_text').notNull(),
    category: text('category', { enum: RESUME_RULE_CATEGORIES }).notNull(),
    active: bool('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('resume_rules_user_id_idx').on(t.userId)],
);

// ---------------------------------------------------------------------------
// 4.3 Pipeline

export const companies = sqliteTable(
  'companies',
  {
    id: id(),
    userId: userRef(),
    name: text('name').notNull(),
    domain: text('domain'),
    careersUrl: text('careers_url'),
    /** Denied companies are kept so they are never re-suggested (FR-D8). */
    status: text('status', { enum: COMPANY_STATUSES }).notNull().default('none'),
    suggestionRationale: text('suggestion_rationale'),
    atsKind: text('ats_kind'),
    atsRef: text('ats_ref'),
    atsVerifiedAt: integer('ats_verified_at'),
    notes: text('notes'),
    /** companyMatchKey(name) from @opportun/core, kept in step with name (issue #193). Null
     *  for a row written before this column existed, until the one-shot repair backfills it
     *  (companyMatchKeyRepair.ts); the near-miss dedupe scan simply finds no match for such a
     *  row's opportunities until then, the same way it would for a brand-new company whose
     *  heuristic has not run yet. */
    companyMatchKey: text('company_match_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('companies_user_id_idx').on(t.userId),
    index('companies_user_name_idx').on(t.userId, t.name),
    index('companies_user_match_key_idx').on(t.userId, t.companyMatchKey),
  ],
);

export const opportunities = sqliteTable(
  'opportunities',
  {
    id: id(),
    userId: userRef(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    roleTargetId: text('role_target_id').references(() => roleTargets.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    descriptionMd: text('description_md'),
    postingUrl: text('posting_url'),
    sourceKind: text('source_kind', { enum: SOURCE_KINDS }).notNull(),
    sourceRef: text('source_ref'),
    location: text('location'),
    remote: bool('remote'),
    compNote: text('comp_note'),
    stage: text('stage', { enum: OPPORTUNITY_STAGES }).notNull(),
    /** Round label within a stage, e.g. "onsite loop". */
    stageDetail: text('stage_detail'),
    closedReason: text('closed_reason', { enum: CLOSED_REASONS }),
    dismissedReason: text('dismissed_reason', { enum: DISMISS_REASONS }),
    priority: integer('priority').notNull().default(2),
    /** Manual position within a stage (issue #240): sparse, step-10, same shape as
     *  resumeRules.sortOrder. Lower sorts first. Server-assigned append-at-bottom on create
     *  and on every stage change; client-set only for an in-stage drag reorder. */
    sortOrder: integer('sort_order').notNull().default(0),
    /** dedupeKey(company, title, location) from @opportun/core; null when not computed. */
    dedupeKey: text('dedupe_key'),
    /** Set once, when `force` bypasses a live dedupe match at create (#9): the opportunity this
     *  one was created as an override of. Null on the override's own row once merged or
     *  dismissed; auto-null on either row when the opportunity it names is deleted. */
    possibleDuplicateOf: text('possible_duplicate_of').references(
      (): AnySQLiteColumn => opportunities.id,
      { onDelete: 'set null' },
    ),
    /** Which req on which ATS board this is, once a board search confirmed it (design D16). */
    atsJobRef: json<AtsJobRef>('ats_job_ref'),
    /** How far the board search got, and why it needs review (design D17). */
    postingState: text('posting_state', { enum: POSTING_STATES }),
    postingStateDetail: text('posting_state_detail', { enum: POSTING_STATE_DETAILS }),
    /** SHA-256 of the description as the system last wrote it, so a user edit is detectable
     *  and never overwritten by a board (design D11). Null: the system never wrote it. */
    descriptionFingerprint: text('description_fingerprint'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('opportunities_user_id_idx').on(t.userId),
    index('opportunities_company_id_idx').on(t.companyId),
    index('opportunities_user_stage_idx').on(t.userId, t.stage),
    uniqueIndex('opportunities_user_dedupe_uq')
      .on(t.userId, t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL`),
    index('opportunities_user_possible_dup_idx').on(t.userId, t.possibleDuplicateOf),
  ],
);

/**
 * A near-miss duplicate pair the cheap heuristic found, or that a user ruled out directly
 * (issue #94). One row per unordered pair (opportunity_id_a < opportunity_id_b by string
 * compare, so detecting from either side finds the same row). This is what makes a decision
 * sticky: a 'rejected' row (from dismiss-duplicate, or a future AI pass saying no) is checked
 * before the heuristic ever writes `opportunities.possible_duplicate_of` again for that exact
 * pair, which #102's dismiss route could not do on its own (it only ever nulled the column,
 * leaving no record that the pair had been looked at and rejected rather than never evaluated).
 * A 'confirmed' row is bookkeeping for the same reason, not the source of truth for display:
 * the possible-duplicate badge/banner still reads `possible_duplicate_of` as #102 built it.
 */
export const opportunityDedupeCandidates = sqliteTable(
  'opportunity_dedupe_candidates',
  {
    id: id(),
    userId: userRef(),
    opportunityIdA: text('opportunity_id_a')
      .notNull()
      .references((): AnySQLiteColumn => opportunities.id, { onDelete: 'cascade' }),
    opportunityIdB: text('opportunity_id_b')
      .notNull()
      .references((): AnySQLiteColumn => opportunities.id, { onDelete: 'cascade' }),
    /** The heuristic's title-overlap score (0-1) at detection time, for the AI pass to
     *  prioritize its queue. Null for a row the user rejected directly: no heuristic score
     *  exists for a pair that was only ever linked via createOpportunity's exact-key force
     *  override (#9), and none is computed solely to fill this in. */
    score: real('score'),
    decision: text('decision', { enum: DEDUPE_CANDIDATE_DECISIONS }).notNull(),
    /** Null while decision is 'pending'. */
    decidedBy: text('decided_by', { enum: DEDUPE_CANDIDATE_DECIDED_BY }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('opportunity_dedupe_candidates_user_id_idx').on(t.userId),
    uniqueIndex('opportunity_dedupe_candidates_pair_uq').on(t.opportunityIdA, t.opportunityIdB),
    index('opportunity_dedupe_candidates_decision_idx').on(t.userId, t.decision),
  ],
);

export const stageHistory = sqliteTable(
  'stage_history',
  {
    id: id(),
    userId: userRef(),
    opportunityId: text('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    /** Null for the initial stage on creation. */
    fromStage: text('from_stage', { enum: OPPORTUNITY_STAGES }),
    toStage: text('to_stage', { enum: OPPORTUNITY_STAGES }).notNull(),
    note: text('note'),
    at: integer('at').notNull(),
  },
  (t) => [
    index('stage_history_user_id_idx').on(t.userId),
    index('stage_history_opportunity_idx').on(t.opportunityId, t.at),
  ],
);

export const activities = sqliteTable(
  'activities',
  {
    id: id(),
    userId: userRef(),
    opportunityId: text('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ACTIVITY_KINDS }).notNull(),
    title: text('title').notNull(),
    bodyMd: text('body_md'),
    occurredAt: integer('occurred_at').notNull(),
    /** Names, or {contactId, name} for a linked contact (referral asks, FR-C4). */
    participants: json<Participant[]>('participants').notNull().default([]),
    externalUrl: text('external_url'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('activities_user_id_idx').on(t.userId),
    index('activities_opportunity_idx').on(t.opportunityId, t.occurredAt),
  ],
);

export const nextSteps = sqliteTable(
  'next_steps',
  {
    id: id(),
    userId: userRef(),
    opportunityId: text('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    dueAt: integer('due_at'),
    doneAt: integer('done_at'),
    owner: text('owner'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('next_steps_user_id_idx').on(t.userId),
    index('next_steps_opportunity_idx').on(t.opportunityId),
  ],
);

export const attachments = sqliteTable(
  'attachments',
  {
    id: id(),
    userId: userRef(),
    /**
     * Nullable, load-bearing: a resume document's content (store local_file, #284) is a row
     * here with no opportunity, since a base resume is not attached to one and a tailored
     * resume's own opportunity link lives on `resumes.opportunity_id`, not here. Nothing in
     * repos/attachments.ts can produce such a row (every function there requires one), so
     * adding `.notNull()` later would silently break the resume store rather than fail loudly
     * where the break happens.
     */
    opportunityId: text('opportunity_id').references(() => opportunities.id, {
      onDelete: 'cascade',
    }),
    /** Original filename: metadata only, never used to form a path (NFR-SEC11). */
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    bytes: integer('bytes').notNull(),
    sha256: text('sha256').notNull(),
    storedPath: text('stored_path').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('attachments_user_id_idx').on(t.userId),
    index('attachments_opportunity_idx').on(t.opportunityId),
  ],
);

// ---------------------------------------------------------------------------
// 4.4 Resumes

export const resumes = sqliteTable(
  'resumes',
  {
    id: id(),
    userId: userRef(),
    kind: text('kind', { enum: RESUME_KINDS }).notNull(),
    opportunityId: text('opportunity_id').references(() => opportunities.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    store: text('store', { enum: RESUME_STORES }).notNull(),
    /** Google Doc id, storage-relative path or Reactive Resume resume id, depending on store. */
    docRef: text('doc_ref').notNull(),
    parentResumeId: text('parent_resume_id').references((): AnySQLiteColumn => resumes.id, {
      onDelete: 'set null',
    }),
    status: text('status', { enum: RESUME_STATUSES }).notNull().default('draft'),
    submittedAt: integer('submitted_at'),
    submittedTo: text('submitted_to'),
    /** Set instead of deleting a submitted resume (#70); status is untouched. */
    archivedAt: integer('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('resumes_user_id_idx').on(t.userId),
    index('resumes_opportunity_idx').on(t.opportunityId),
  ],
);

export const tailoringSessions = sqliteTable(
  'tailoring_sessions',
  {
    id: id(),
    userId: userRef(),
    resumeId: text('resume_id')
      .notNull()
      .references(() => resumes.id, { onDelete: 'cascade' }),
    taskRunIds: json<string[]>('task_run_ids').notNull().default([]),
    transcript: json<TranscriptTurn[]>('transcript').notNull().default([]),
    acceptedAt: integer('accepted_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('tailoring_sessions_user_id_idx').on(t.userId),
    index('tailoring_sessions_resume_idx').on(t.resumeId),
  ],
);

/**
 * The latest resume.match report for one (resume, opportunity) pair (issue #175). Latest
 * only, not history: a match report is a claim about how well the document fits as of
 * scoredAt, which stops being useful as soon as a newer one exists, and keeping every past
 * one would open a retention question on stored model output this project otherwise avoids
 * (the mail-body-never-stored guarantee, NFR-PRV5). Composite primary key, no synthetic id,
 * same convention as sync_state: this is a 1:1 row per pair, not a log. ON DELETE CASCADE on
 * both sides, not SET NULL like resumes.opportunity_id: a report has no meaning with either
 * half of its key gone, so cascade is what actually satisfies "no orphan report" rather than
 * leaving a row with half its identity nulled out.
 */
export const resumeMatchReports = sqliteTable(
  'resume_match_reports',
  {
    userId: userRef(),
    resumeId: text('resume_id')
      .notNull()
      .references(() => resumes.id, { onDelete: 'cascade' }),
    opportunityId: text('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    report: json<MatchReport>('report').notNull(),
    scoredAt: integer('scored_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.resumeId, t.opportunityId] }),
    index('resume_match_reports_user_id_idx').on(t.userId),
  ],
);

// ---------------------------------------------------------------------------
// 4.5 Discovery and AI

export const discoverySources = sqliteTable(
  'discovery_sources',
  {
    id: id(),
    userId: userRef(),
    kind: text('kind', { enum: DISCOVERY_SOURCE_KINDS }).notNull(),
    /**
     * Org slug, MCP server + tool, or endpoint, depending on kind (validated per kind). The
     * engine keeps the adapter's paging cursor here under `cursor`.
     */
    config: json<Record<string, unknown>>('config').notNull().default({}),
    enabled: bool('enabled').notNull().default(true),
    scheduleCron: text('schedule_cron'),
    /** Results from this source are ranked against this role target (null: none). */
    roleTargetId: text('role_target_id').references(() => roleTargets.id, {
      onDelete: 'set null',
    }),
    /** The followed company whose ATS board this source polls (null for other sources). */
    companyId: text('company_id').references(() => companies.id, { onDelete: 'set null' }),
    lastRunAt: integer('last_run_at'),
    /** 'error' after a failed run (status_detail says why); the next success resets it. */
    status: text('status', { enum: DISCOVERY_SOURCE_STATUSES }).notNull().default('ok'),
    statusDetail: text('status_detail'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('discovery_sources_user_id_idx').on(t.userId)],
);

export const discoveryRuns = sqliteTable(
  'discovery_runs',
  {
    id: id(),
    userId: userRef(),
    sourceId: text('source_id')
      .notNull()
      .references(() => discoverySources.id, { onDelete: 'cascade' }),
    roleTargetId: text('role_target_id').references(() => roleTargets.id, {
      onDelete: 'set null',
    }),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
    stats: json<Record<string, unknown>>('stats'),
    error: text('error'),
  },
  (t) => [
    index('discovery_runs_user_id_idx').on(t.userId),
    index('discovery_runs_source_idx').on(t.sourceId),
  ],
);

export const discoveryResults = sqliteTable(
  'discovery_results',
  {
    id: id(),
    userId: userRef(),
    runId: text('run_id')
      .notNull()
      .references(() => discoveryRuns.id, { onDelete: 'cascade' }),
    /** Normalized posting (JSON). */
    posting: json<Record<string, unknown>>('posting').notNull(),
    dedupeKey: text('dedupe_key'),
    aiScore: real('ai_score'),
    aiRationale: text('ai_rationale'),
    resolution: text('resolution', { enum: RESOLUTIONS }).notNull(),
    /** ATS posting reference when resolved. */
    resolvedSourceRef: text('resolved_source_ref'),
    disposition: text('disposition', { enum: DISPOSITIONS }).notNull().default('pending'),
    opportunityId: text('opportunity_id').references(() => opportunities.id, {
      onDelete: 'set null',
    }),
    /**
     * The message this lead was parsed out of, for a channel that delivers postings by mail
     * (design D3b). Set null when that message goes, because the lead may still be in use.
     */
    sourceCommunicationId: text('source_communication_id').references(() => communications.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('discovery_results_user_id_idx').on(t.userId),
    index('discovery_results_run_idx').on(t.runId),
    index('discovery_results_user_dedupe_idx').on(t.userId, t.dedupeKey),
  ],
);

/**
 * Feedback rows that feed prompt refinement (FR-D6). kind 'dismissal' rows come from
 * dismissing an opportunity or discovery result; kind 'classification' rows record a
 * user's correction of a communication's classification.
 */
/**
 * The user's own mail filter rules (spec D1 rules 0, 1 and 4; D7). The consumer-domain veto of
 * rule 2 is NOT stored here: it is a built-in list behind one per-user toggle, so this table
 * holds only what the user wrote or what rejection added on their behalf.
 *
 * `effect` carries precedence as well as action: allow is rule 0 and beats every heuristic,
 * deny is rule 1, and job_sender is rule 4, which passes a sender but only after the vetoes at
 * rules 2 and 3 have had their say. That distinction is load-bearing: a job_sender entry that
 * could override the private-content veto would expose, for example, the unemployment-claim
 * mail that shares state-benefits.example with its hiring-event mail.
 */
export const mailFilterRules = sqliteTable(
  'mail_filter_rules',
  {
    id: id(),
    userId: userRef(),
    /** A sender pattern as parseMailPattern accepts it (exact address, *@domain, *@*.domain). */
    pattern: text('pattern').notNull(),
    effect: text('effect', { enum: MAIL_FILTER_EFFECTS }).notNull(),
    enabled: bool('enabled').notNull().default(true),
    source: text('source', { enum: MAIL_FILTER_SOURCES }).notNull().default('user'),
    /** Why this rule exists, shown in settings so a rejection-added entry can be undone. */
    note: text('note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('mail_filter_rules_user_id_idx').on(t.userId),
    uniqueIndex('mail_filter_rules_user_effect_pattern_uq').on(t.userId, t.effect, t.pattern),
  ],
);

export const dismissalFeedback = sqliteTable(
  'dismissal_feedback',
  {
    id: id(),
    userId: userRef(),
    kind: text('kind', { enum: FEEDBACK_KINDS }).notNull().default('dismissal'),
    opportunityId: text('opportunity_id').references(() => opportunities.id, {
      onDelete: 'set null',
    }),
    resultId: text('result_id').references(() => discoveryResults.id, { onDelete: 'set null' }),
    communicationId: text('communication_id').references(() => communications.id, {
      onDelete: 'set null',
    }),
    reason: text('reason'),
    note: text('note'),
    /** The user opted this one note in to prompt refinement; off by default (spec D4). */
    shareNote: bool('share_note').notNull().default(false),
    at: integer('at').notNull(),
  },
  (t) => [
    index('dismissal_feedback_user_id_idx').on(t.userId),
    index('dismissal_feedback_user_kind_at_idx').on(t.userId, t.kind, t.at),
  ],
);

/** The cost ledger (FR-A5) aggregates this table. Never stores raw prompts. */
export const taskRuns = sqliteTable(
  'task_runs',
  {
    id: id(),
    userId: userRef(),
    taskKey: text('task_key').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptId: text('prompt_id').references(() => prompts.id, { onDelete: 'set null' }),
    promptVersion: integer('prompt_version'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /** Estimated cost in USD. */
    estCost: real('est_cost').notNull().default(0),
    /** True when the model had no list price and the conservative fallback price was used. */
    fallbackPricing: bool('fallback_pricing').notNull().default(false),
    durationMs: integer('duration_ms').notNull().default(0),
    status: text('status', { enum: TASK_RUN_STATUSES }).notNull(),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [
    index('task_runs_user_id_idx').on(t.userId),
    index('task_runs_user_task_created_idx').on(t.userId, t.taskKey, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// 4.6 Contacts and communications

export const contacts = sqliteTable(
  'contacts',
  {
    id: id(),
    userId: userRef(),
    name: text('name').notNull(),
    emails: json<string[]>('emails').notNull().default([]),
    linkedinUrl: text('linkedin_url'),
    currentCompanyId: text('current_company_id').references(() => companies.id, {
      onDelete: 'set null',
    }),
    history: json<Record<string, unknown>[]>('history').notNull().default([]),
    strength: integer('strength'),
    notes: text('notes'),
    source: text('source', { enum: CONTACT_SOURCES }).notNull().default('manual'),
    tags: json<string[]>('tags').notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('contacts_user_id_idx').on(t.userId),
    index('contacts_user_company_idx').on(t.userId, t.currentCompanyId),
  ],
);

/** Ingested copies only; the user's mailbox is never modified (FR-M8). */
export const communications = sqliteTable(
  'communications',
  {
    id: id(),
    userId: userRef(),
    channel: text('channel', { enum: COMM_CHANNELS }).notNull(),
    /** Unique per channel for idempotent sync. */
    externalId: text('external_id').notNull(),
    threadKey: text('thread_key'),
    from: text('from').notNull(),
    to: json<string[]>('to').notNull().default([]),
    subject: text('subject'),
    snippet: text('snippet'),
    /** Storage pointer to the body; the body is not duplicated into the DB. */
    bodyRef: text('body_ref'),
    sentAt: integer('sent_at').notNull(),
    classification: text('classification', { enum: COMM_CLASSIFICATIONS }),
    /** Null for messages that are not recruiter outreach. */
    outreachKind: text('outreach_kind', { enum: OUTREACH_KINDS }),
    mismatchReason: text('mismatch_reason'),
    confidence: real('confidence'),
    /** What the classifier actually read (issue #149); null for a message never classified,
     * or classified before this column existed. */
    bodySource: text('body_source', { enum: BODY_SOURCES }),
    opportunityId: text('opportunity_id').references(() => opportunities.id, {
      onDelete: 'set null',
    }),
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    needsReview: bool('needs_review').notNull().default(false),
    /**
     * A stage change the classifier proposes for the linked opportunity (FR-M2). Stored only;
     * it is applied when the user accepts it.
     */
    proposedTransition: text('proposed_transition', { enum: OPPORTUNITY_STAGES }),
    /** Stage 1 verdict (spec D1): 'passed' reached the classifier, 'filtered' never did. */
    triageDecision: text('triage_decision'),
    /** Which rule decided, so the blocked view can say why without storing the message. */
    triageRule: text('triage_rule'),
    /**
     * ATS job references extracted from the body at ingest (design D-5). Stored because the
     * body is not: find-posting reads these instead of re-reading a message that no longer
     * exists on disk, and unlike re-fetching it works for Apple Mail and LinkedIn too.
     */
    atsJobRefs: json<AtsJobRefRecord[]>('ats_job_refs'),
    /** Set when the user rejected this message as out of scope (spec D4). */
    rejectedAt: integer('rejected_at'),
    rejectionReason: text('rejection_reason', { enum: REJECTION_REASONS }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('communications_user_id_idx').on(t.userId),
    uniqueIndex('communications_user_channel_external_uq').on(t.userId, t.channel, t.externalId),
    index('communications_user_thread_idx').on(t.userId, t.threadKey),
    index('communications_opportunity_idx').on(t.opportunityId),
  ],
);

export const syncState = sqliteTable(
  'sync_state',
  {
    userId: userRef(),
    integration: text('integration').notNull(),
    /** Provider cursor, e.g. Gmail historyId. */
    cursor: json<unknown>('cursor'),
    lastSyncAt: integer('last_sync_at'),
    status: text('status'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.integration] })],
);

// ---------------------------------------------------------------------------
// Section 8: background jobs, and settings

export const jobs = sqliteTable(
  'jobs',
  {
    id: id(),
    kind: text('kind').notNull(),
    payload: json<unknown>('payload').notNull(),
    runAt: integer('run_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    lockedBy: text('locked_by'),
    lockedAt: integer('locked_at'),
    lastError: text('last_error'),
    status: text('status', { enum: JOB_STATUSES }).notNull().default('pending'),
    /** Suppresses duplicate enqueues of an unfinished job with the same kind. */
    dedupeKey: text('dedupe_key'),
    /** The user a job acts for (e.g. an import); null for instance jobs such as backups. */
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** Progress or outcome a handler reports (e.g. an import report). */
    result: json<unknown>('result'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('jobs_status_run_at_idx').on(t.status, t.runAt),
    index('jobs_kind_dedupe_idx').on(t.kind, t.dedupeKey),
    // One unfinished job per (kind, dedupe_key): enqueue's insert-or-nothing (0019).
    uniqueIndex('jobs_unfinished_dedupe_uq')
      .on(t.kind, t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL AND ${t.status} IN ('pending', 'running')`),
    index('jobs_user_id_idx').on(t.userId),
  ],
);

/** Key-value settings. user_id null marks an instance-wide setting. */
export const settings = sqliteTable(
  'settings',
  {
    key: text('key').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    value: json<unknown>('value').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [index('settings_user_id_idx').on(t.userId)],
);
